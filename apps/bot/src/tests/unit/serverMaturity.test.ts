/**
 * Detection « serveur neuf » / « serveur etabli ».
 *
 * Elle decide de ce que la mise en place propose par defaut, et se tromper
 * coute cher dans un seul sens : recreer une arborescence sur un serveur habite
 * y double des salons dont des gens se servent. Ces cas fixent donc surtout que
 * le doute profite a la reprise.
 */
import { describe, expect, test } from 'bun:test';
import { assessServerMaturity } from '../../services/core/serverTemplateService.js';

const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

/** Serveur cree a l'instant, encore nu : le cas « je monte ma communaute ». */
const fresh = {
  createdAt: daysAgo(1),
  memberCount: 3,
  channelCount: 4,
  roleCount: 1,
};

describe('assessServerMaturity', () => {
  test('un serveur cree hier et vide est un serveur neuf', () => {
    const verdict = assessServerMaturity(fresh);

    expect(verdict.maturity).toBe('fresh');
    expect(verdict.reasons).toEqual([]);
  });

  test('un seul signal suffit a basculer en serveur etabli', () => {
    // Les signaux ne se compensent pas : un serveur de trois jours avec deux
    // mille membres est un serveur etabli, quoi qu'en dise son age.
    expect(assessServerMaturity({ ...fresh, memberCount: 2_000 }).maturity).toBe('established');
    expect(assessServerMaturity({ ...fresh, channelCount: 40 }).maturity).toBe('established');
    expect(assessServerMaturity({ ...fresh, roleCount: 20 }).maturity).toBe('established');
    expect(assessServerMaturity({ ...fresh, createdAt: daysAgo(400) }).maturity).toBe('established');
  });

  test('un serveur ancien reste etabli meme vide', () => {
    // On ne debarque pas en recreant tout sur un serveur qui existe depuis deux
    // ans, meme s'il s'est vide entre-temps.
    const verdict = assessServerMaturity({
      createdAt: daysAgo(730),
      memberCount: 2,
      channelCount: 3,
      roleCount: 0,
    });

    expect(verdict.maturity).toBe('established');
  });

  test('le motif du verdict est dit, pas seulement le verdict', () => {
    // Une recommandation dont on ne voit pas le motif se fait ignorer - et
    // celle-ci se trompera parfois.
    const verdict = assessServerMaturity({
      createdAt: daysAgo(365),
      memberCount: 800,
      channelCount: 60,
      roleCount: 25,
    });

    expect(verdict.reasons).toHaveLength(4);
    expect(verdict.reasons.join(' ')).toContain('800 membres');
    expect(verdict.reasons.join(' ')).toContain('60 salons');
    expect(verdict.reasons.join(' ')).toContain('25 rôles');
  });

  test('les seuils sont inclusifs sur l age et les membres', () => {
    // Ecrits ici pour qu'un ajustement de seuil soit un choix, pas un effet de
    // bord : 30 jours et 50 membres basculent, la veille et un membre de moins
    // non.
    expect(assessServerMaturity({ ...fresh, createdAt: daysAgo(30) }).maturity).toBe('established');
    expect(assessServerMaturity({ ...fresh, createdAt: daysAgo(29) }).maturity).toBe('fresh');

    expect(assessServerMaturity({ ...fresh, memberCount: 50 }).maturity).toBe('established');
    expect(assessServerMaturity({ ...fresh, memberCount: 49 }).maturity).toBe('fresh');
  });

  test('une horloge en avance ne fabrique pas un serveur du futur', () => {
    // L'horloge du bot peut devancer celle de Discord : sans garde, l'age
    // devenait negatif et le serveur passait pour tres jeune.
    const verdict = assessServerMaturity({ ...fresh, createdAt: new Date(Date.now() + 10 * DAY) });

    expect(verdict.ageDays).toBe(0);
    expect(verdict.maturity).toBe('fresh');
  });
});
