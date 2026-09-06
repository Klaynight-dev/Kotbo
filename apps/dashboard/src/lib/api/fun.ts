/** Modules fun. */
import { authStore } from '../stores/auth.svelte';
import { dashboardRequest } from './client';

// Fun API functions
export async function fetchFunConfig(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/fun', { method: 'GET', guildId, errorContext: 'API Error (Fetch Fun Config):' });
}

export async function updateFunConfig(config, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/fun', { method: 'PATCH', payload: config, guildId, errorContext: 'API Error (Update Fun Config):' });
}

export async function resetCountingGame(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/fun/counting/reset', { method: 'POST', guildId, errorContext: 'API Error (Reset Counting):' });
}

export async function resetGuessNumberGame(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/fun/guess-number/reset', { method: 'POST', guildId, errorContext: 'API Error (Reset Guess Number):' });
}

export async function resetWordChainGame(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/fun/word-chain/reset', { method: 'POST', guildId, errorContext: 'API Error (Reset Word Chain):' });
}

export async function resetEmojiRiddleGame(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/fun/emoji-riddle/reset', { method: 'POST', guildId, errorContext: 'API Error (Reset Emoji Riddle):' });
}
