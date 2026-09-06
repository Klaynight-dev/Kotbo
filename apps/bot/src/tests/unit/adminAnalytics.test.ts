/**
 * adminAnalytics.test.ts
 *
 * Tests unitaires des calculs et exports du service d'analyse d'administration.
 */

import { describe, expect, it, mock } from 'bun:test';
import {
  parseDateRange,
  formatCsv,
  exportAnalyticsCsv,
  saveAlertThresholds,
  getAlertThresholds,
} from '../../services/analytics/adminAnalyticsService.js';
import { Client } from 'discord.js';

describe('adminAnalyticsService', () => {
  describe('parseDateRange', () => {
    it('calcule correctement une période par défaut de 30 jours', () => {
      const range = parseDateRange();
      expect(range.daysDiff).toBeGreaterThanOrEqual(30);
      expect(range.useSnapshots).toBe(true);
      expect(range.to.getTime()).toBeGreaterThan(range.from.getTime());
    });

    it('bascule sur les données temps réel en deçà ou égal à 7 jours', () => {
      const now = new Date();
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
      const range = parseDateRange(threeDaysAgo.toISOString(), now.toISOString());
      expect(range.useSnapshots).toBe(false);
    });

    it('calcule les bornes de la période précédente pour la comparaison', () => {
      const from = new Date('2026-06-01T00:00:00.000Z');
      const to = new Date('2026-06-30T00:00:00.000Z');
      const range = parseDateRange(from.toISOString(), to.toISOString());

      expect(range.previousTo.toISOString()).toBe(from.toISOString());
      const duration = to.getTime() - from.getTime();
      expect(range.previousFrom.getTime()).toBe(from.getTime() - duration);
    });
  });

  describe('formatCsv', () => {
    it('échappe correctement les virgules, guillemets et retours à la ligne', () => {
      const headers = ['Nom', 'Commentaire', 'Montant'];
      const rows = [
        ['Serveur 1', 'Bonjour, tout le monde', 10],
        ['Serveur "VIP"', 'Ligne 1\nLigne 2', 25.5],
      ];
      const csv = formatCsv(headers, rows);

      // Présence du BOM UTF-8
      expect(csv.startsWith('\uFEFF')).toBe(true);
      expect(csv).toContain('"Bonjour, tout le monde"');
      expect(csv).toContain('"Serveur ""VIP"""');
      expect(csv).toContain('"Ligne 1\nLigne 2"');
    });
  });

  describe('exportAnalyticsCsv', () => {
    it('génère un export funnel au format RFC 4180 avec en-têtes corrects', async () => {
      const mockClient = { guilds: { cache: new Map() } } as unknown as Client;
      const res = await exportAnalyticsCsv(mockClient, 'funnel', {});

      expect(res.filename).toContain('kotbo-funnel-');
      expect(res.filename.endsWith('.csv')).toBe(true);
      expect(res.content.startsWith('\uFEFF')).toBe(true);
      expect(res.content).toContain('Étape,Libellé,Nombre');
    });

    it('génère un export revenue avec colonnes MRR et encaissé', async () => {
      const mockClient = { guilds: { cache: new Map() } } as unknown as Client;
      const res = await exportAnalyticsCsv(mockClient, 'revenue', {});

      expect(res.filename).toContain('kotbo-revenue-');
      expect(res.content).toContain('Date,MRR (€),Encaissé (€),Serveurs payants');
    });

    it('génère un export cohorts avec les colonnes M0 à M12', async () => {
      const mockClient = { guilds: { cache: new Map() } } as unknown as Client;
      const res = await exportAnalyticsCsv(mockClient, 'cohorts', {});

      expect(res.filename).toContain('kotbo-cohorts-');
      expect(res.content).toContain('Cohorte,Serveurs initiaux,MRR initial (€),M0 (%),M1 (%)');
    });

    it('génère un export risks avec colonnes de risque et motif', async () => {
      const mockClient = { guilds: { cache: new Map() } } as unknown as Client;
      const res = await exportAnalyticsCsv(mockClient, 'risks', {});

      expect(res.filename).toContain('kotbo-risks-');
      expect(res.content).toContain('Catégorie,Identifiant,Nom,Offre,MRR à risque (€),Motif');
    });
  });

  describe('alertThresholds', () => {
    it('lit les seuils par défaut', async () => {
      const { thresholds } = await getAlertThresholds();
      expect(thresholds.monthlyChurnRatePct).toBeDefined();
      expect(thresholds.largeServerChurnMembers).toBeDefined();
      expect(thresholds.arrivalsDropPct).toBeDefined();
    });
  });
});
