/** Reglement interne. */
import { authStore } from '../stores/auth.svelte';
import { dashboardMutation, dashboardRequest } from './client';

export async function createRegulationArticle(article, guildId = authStore.selectedGuildId, options: { silent?: boolean } = {}) {
  return dashboardMutation('/regulation/articles', {
    method: 'POST',
    payload: article,
    guildId,
    // Muet quand l'ecriture vient du parcours de configuration : celui-ci pose
    // le reglement entier d'un clic, et le toast du socle sortirait une fois
    // par article.
    silent: options.silent,
    errorContext: 'API Error (Create Regulation Article):'
  });
}

export async function updateRegulationArticle(articleId, article, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/regulation/articles/${articleId}`, {
    method: 'PATCH',
    payload: article,
    guildId,
    errorContext: 'API Error (Update Regulation Article):'
  });
}

export async function reorderRegulationArticles(articleIds, guildId = authStore.selectedGuildId) {
  return dashboardMutation('/regulation/articles/reorder', {
    method: 'PATCH',
    payload: { articleIds },
    guildId,
    errorContext: 'API Error (Reorder Regulation Articles):'
  });
}

export async function deleteRegulationArticle(articleId, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/regulation/articles/${articleId}`, {
    method: 'DELETE',
    guildId,
    errorContext: 'API Error (Delete Regulation Article):'
  });
}

export async function publishRegulation(guildId = authStore.selectedGuildId, options: { silent?: boolean } = {}) {
  return dashboardRequest('/regulation/publish', {
    method: 'POST',
    guildId,
    silent: options.silent,
    errorContext: 'API Error (Publish Regulation):'
  });
}

export async function updateRegulationSettings(payload: any, guildId = authStore.selectedGuildId) {
  return dashboardMutation('/settings', {
    method: 'PATCH',
    payload,
    guildId,
    errorContext: 'API Error (Regulation Settings):'
  });
}
