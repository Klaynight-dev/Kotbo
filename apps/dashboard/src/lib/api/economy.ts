/** Economie et RPG. */
import { authStore } from '../stores/auth.svelte';
import { dashboardMutation, dashboardRequest } from './client';

// ==========================================
// ECONOMY & RPG APIs
// ==========================================
export async function fetchEconomyConfig(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/economy/config', { method: 'GET', guildId, errorContext: 'API Error (Fetch Economy Config):' });
}

export async function updateEconomyConfig(config: any, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/economy/config', { method: 'PATCH', payload: config, guildId, errorContext: 'API Error (Update Economy Config):' });
}

export async function fetchRpgItems(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/economy/items', { method: 'GET', guildId, errorContext: 'API Error (Fetch RPG Items):' });
}

export async function saveRpgItem(item: any, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/economy/items', { method: 'POST', payload: item, guildId, errorContext: 'API Error (Save RPG Item):' });
}

export async function deleteRpgItem(itemId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/economy/items/${itemId}`, { method: 'DELETE', guildId, errorContext: 'API Error (Delete RPG Item):' });
}

export async function fetchRpgMonsters(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/economy/monsters', { method: 'GET', guildId, errorContext: 'API Error (Fetch RPG Monsters):' });
}

export async function saveRpgMonster(monster: any, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/economy/monsters', { method: 'POST', payload: monster, guildId, errorContext: 'API Error (Save RPG Monster):' });
}

export async function setRpgMonsterEnabled(monsterId: string, enabled: boolean, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/economy/monsters/${monsterId}`, { method: 'PATCH', payload: { enabled }, guildId, errorContext: 'API Error (Toggle RPG Monster):' });
}

export async function deleteRpgMonster(monsterId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/economy/monsters/${monsterId}`, { method: 'DELETE', guildId, errorContext: 'API Error (Delete RPG Monster):' });
}

export async function applyRpgBestiaryDifficulty(
  scope: 'boss' | 'monster',
  difficulty: string,
  options: { preview?: boolean } = {},
  guildId = authStore.selectedGuildId,
) {
  return dashboardRequest('/economy/monsters/difficulty', {
    method: 'POST',
    payload: { scope, difficulty, preview: options.preview === true },
    guildId,
    // Un essai a blanc ne doit pas annoncer une operation reussie : rien n'a bouge.
    silent: options.preview === true,
    errorContext: 'API Error (Apply RPG Bestiary Difficulty):',
  });
}

export async function applyRpgShopDifficulty(
  difficulty: string,
  options: { preview?: boolean } = {},
  guildId = authStore.selectedGuildId,
) {
  return dashboardRequest('/economy/items/difficulty', {
    method: 'POST',
    payload: { difficulty, preview: options.preview === true },
    guildId,
    silent: options.preview === true,
    errorContext: 'API Error (Apply RPG Shop Difficulty):',
  });
}

export async function exportRpgBestiary(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/economy/monsters/export', { method: 'GET', guildId, errorContext: 'API Error (Export RPG Bestiary):' });
}

export async function importRpgBestiary(payload: unknown, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/economy/monsters/import', { method: 'POST', payload, guildId, errorContext: 'API Error (Import RPG Bestiary):' });
}

export async function fetchRpgRaid(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/economy/raid', { method: 'GET', guildId, errorContext: 'API Error (Fetch RPG Raid):' });
}

export async function saveRpgRaidBoss(boss: any, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/economy/raid/bosses', { method: 'POST', payload: boss, guildId, errorContext: 'API Error (Save RPG Raid Boss):' });
}

export async function deleteRpgRaidBoss(bossId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/economy/raid/bosses/${bossId}`, { method: 'DELETE', guildId, errorContext: 'API Error (Delete RPG Raid Boss):' });
}

export async function startRpgRaid(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/economy/raid/start', { method: 'POST', payload: {}, guildId, errorContext: 'API Error (Start RPG Raid):' });
}

export async function restoreRpgRaidBosses(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/economy/raid/seed', { method: 'POST', payload: {}, guildId, errorContext: 'API Error (Restore RPG Raid Bosses):' });
}

export async function fetchRpgQuests(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/economy/quests', { method: 'GET', guildId, errorContext: 'API Error (Fetch RPG Quests):' });
}

export async function saveRpgQuest(quest: any, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/economy/quests', { method: 'POST', payload: quest, guildId, errorContext: 'API Error (Save RPG Quest):' });
}

export async function deleteRpgQuest(questId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/economy/quests/${questId}`, { method: 'DELETE', guildId, errorContext: 'API Error (Delete RPG Quest):' });
}

export async function fetchRpgRecipes(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/economy/recipes', { method: 'GET', guildId, errorContext: 'API Error (Fetch RPG Recipes):' });
}

export async function saveRpgRecipe(recipe: any, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/economy/recipes', { method: 'POST', payload: recipe, guildId, errorContext: 'API Error (Save RPG Recipe):' });
}

export async function deleteRpgRecipe(recipeId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/economy/recipes/${recipeId}`, { method: 'DELETE', guildId, errorContext: 'API Error (Delete RPG Recipe):' });
}

export async function fetchRpgPlayers(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/economy/players', { method: 'GET', guildId, errorContext: 'API Error (Fetch RPG Players):' });
}

export async function updateRpgPlayer(userId: string, payload: any, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/economy/players/${userId}`, { method: 'PATCH', payload, guildId, errorContext: 'API Error (Update RPG Player):' });
}

export async function resetEconomy(component: 'all' | 'profiles' | 'items' | 'config' | 'guilds' | 'bestiary', guildId = authStore.selectedGuildId) {
  return dashboardRequest('/economy/reset', { method: 'POST', payload: { component }, guildId, errorContext: 'API Error (Reset Economy):' });
}

export async function updateSanctionTables(tables, guildId = authStore.selectedGuildId) {
  return dashboardMutation('/sanctions/tables', {
    method: 'PUT',
    payload: tables,
    guildId,
    errorContext: 'API Error (Update Sanction Tables):'
  });
}

// ── MCP API Keys ────────────────────────────────────────────────────────────
