/**
 * acquisitionAlertsService.test.ts
 *
 * Tests unitaires du service d'alertes Discord et du récapitulatif commercial
 * hebdomadaire du tunnel d'acquisition.
 */
import { describe, expect, test } from 'bun:test';
import { EmbedBuilder } from 'discord.js';
import { runAcquisitionAlertsCheck, runWeeklyAcquisitionRecap } from '../../services/analytics/acquisitionAlertsService.js';

describe('acquisitionAlertsService', () => {
  test('construit un embed valide sans lever d\'exception', () => {
    const embed = new EmbedBuilder()
      .setTitle('Test Alerte')
      .setDescription('Description de test')
      .setColor(0x5865F2)
      .addFields({ name: 'Champ', value: 'Valeur' });

    const json = embed.toJSON();
    expect(json.title).toBe('Test Alerte');
    expect(json.description).toBe('Description de test');
    expect(json.color).toBe(0x5865F2);
  });

  test('runAcquisitionAlertsCheck s\'exécute avec succès même si la base est vide', async () => {
    const mockClient = {
      users: {
        fetch: async () => null,
      },
      guilds: {
        cache: new Map(),
      },
    } as any;

    await expect(runAcquisitionAlertsCheck(mockClient)).resolves.toBeUndefined();
  });

  test('runWeeklyAcquisitionRecap s\'exécute avec succès même si la base est vide', async () => {
    const mockClient = {
      users: {
        fetch: async () => null,
      },
      guilds: {
        cache: new Map(),
      },
    } as any;

    await expect(runWeeklyAcquisitionRecap(mockClient)).resolves.toBeUndefined();
  });
});
