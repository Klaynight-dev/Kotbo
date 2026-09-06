/** Protection anti-raid. */
import { authStore } from '../stores/auth.svelte';
import { dashboardMutation, dashboardRequest } from './client';

// ─────────────────────────────────────────────────────────────
// Raid Protection (captcha, anti-raid, locks, reports, invites, scam)
// ─────────────────────────────────────────────────────────────

export async function fetchRaidProtection(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/raid-protection', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Raid Protection):'
  });
}

// Ces routes renvoient la config mise a jour : on passe par dashboardRequest
// pour recuperer le corps JSON (dashboardMutation ne renvoie qu'un booleen).
export async function updateRaidProtection(
  payload: Record<string, unknown>,
  guildId = authStore.selectedGuildId,
  /** Voir `updateAutoModConfig` : muet quand l'ecriture vient du parcours. */
  options: { silent?: boolean } = {},
) {
  return dashboardRequest('/raid-protection', {
    method: 'PATCH',
    silent: options.silent,
    payload,
    guildId,
    errorContext: 'API Error (Update Raid Protection):'
  });
}

export async function setRaidMode(active: boolean, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/raid-protection/raidmode', {
    method: 'POST',
    payload: { active },
    guildId,
    errorContext: 'API Error (Raid Mode):'
  });
}

export async function setJoinLock(active: boolean, hours?: number, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/raid-protection/joinlock', {
    method: 'POST',
    payload: { active, hours },
    guildId,
    errorContext: 'API Error (Join Lock):'
  });
}

export async function setDmLock(active: boolean, hours?: number, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/raid-protection/dmlock', {
    method: 'POST',
    payload: { active, hours },
    guildId,
    errorContext: 'API Error (DM Lock):'
  });
}

export async function setInviteEmergency(active: boolean, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/raid-protection/invite-emergency', {
    method: 'POST',
    payload: { active },
    guildId,
    errorContext: 'API Error (Invite Emergency):'
  });
}

export async function fetchMemberReports(status?: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/raid-protection/reports${status ? `?status=${status}` : ''}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Member Reports):'
  });
}

export async function decideMemberReport(reportId: string, resolved: boolean, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/raid-protection/reports/${reportId}/decision`, {
    method: 'POST',
    payload: { resolved },
    guildId,
    errorContext: 'API Error (Report Decision):'
  });
}

export async function fetchInviteRequests(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/raid-protection/invite-requests', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Invite Requests):'
  });
}

export async function decideInviteRequest(requestId: string, approved: boolean, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/raid-protection/invite-requests/${requestId}/decision`, {
    method: 'POST',
    payload: { approved },
    guildId,
    errorContext: 'API Error (Invite Decision):'
  });
}

export async function fetchScamImages(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/raid-protection/scam-images', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Scam Images):'
  });
}

export async function deleteScamImage(imageId: string, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/raid-protection/scam-images/${imageId}`, {
    method: 'DELETE',
    guildId,
    errorContext: 'API Error (Delete Scam Image):'
  });
}

// ─────────────────────────────────────────────────────────────
// Audit de securite
// ─────────────────────────────────────────────────────────────

/** `deep` active les controles necessitant la liste complete des membres. */
export async function fetchSecurityAudit(deep = true, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/raid-protection/audit${deep ? '' : '?deep=0'}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Security Audit):'
  });
}

// ─────────────────────────────────────────────────────────────
// Lignage des invitations
// ─────────────────────────────────────────────────────────────

export async function fetchInviteLineage(userId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/raid-protection/lineage/${userId}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Invite Lineage):'
  });
}

/** `dryRun` (defaut true) se contente de lister les membres qui seraient touches. */
export async function quarantineInviteLineage(
  userId: string,
  options: { dryRun?: boolean; maxDepth?: number; sinceDays?: number; quarantineRoleId?: string | null } = {},
  guildId = authStore.selectedGuildId
) {
  return dashboardRequest(`/raid-protection/lineage/${userId}/quarantine`, {
    method: 'POST',
    payload: { dryRun: true, ...options },
    guildId,
    errorContext: 'API Error (Lineage Quarantine):'
  });
}

// ─────────────────────────────────────────────────────────────
// Moteur anti-spam comportemental
// ─────────────────────────────────────────────────────────────

export async function fetchSpamDetection(days = 14, guildId = authStore.selectedGuildId) {
  return dashboardRequest(`/raid-protection/spam?days=${days}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Spam Detection):'
  });
}

export async function updateSpamDetection(payload: Record<string, unknown>, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/raid-protection/spam', {
    method: 'PATCH',
    payload,
    guildId,
    errorContext: 'API Error (Update Spam Detection):'
  });
}

export async function fetchSpamSamples(
  options: { pendingOnly?: boolean; minScore?: number } = {},
  guildId = authStore.selectedGuildId
) {
  const params = new URLSearchParams();
  if (options.pendingOnly) params.set('pending', '1');
  if (options.minScore) params.set('minScore', String(options.minScore));
  const query = params.toString();

  return dashboardRequest(`/raid-protection/spam/samples${query ? `?${query}` : ''}`, {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Spam Samples):'
  });
}

export async function decideSpamSample(sampleId: string, truePositive: boolean, guildId = authStore.selectedGuildId) {
  return dashboardMutation(`/raid-protection/spam/samples/${sampleId}/decision`, {
    method: 'POST',
    payload: { truePositive },
    guildId,
    errorContext: 'API Error (Spam Decision):'
  });
}

// `silent` : le correctif rend un message qui nomme ce qui a change, et
// SecurityAudit l'affiche lui-meme (succes comme echec). Sans cela le toast
// generique de dashboardRequest s'empilait par-dessus, d'ou la double notif.
export async function applySecurityFix(findingId: string, guildId = authStore.selectedGuildId) {
  return dashboardRequest('/raid-protection/audit/fix', {
    method: 'POST',
    payload: { findingId },
    guildId,
    silent: true,
    errorContext: 'API Error (Security Fix):'
  });
}

// Applique en une passe tous les correctifs sans risque. Les correctifs
// `risky` sont exclus cote serveur : ils gardent leur bouton et leur
// confirmation individuelle. `silent` pour la meme raison que ci-dessus - la
// page rend son propre recapitulatif (N appliques, M en echec).
export async function applyAllSecurityFixes(guildId = authStore.selectedGuildId) {
  return dashboardRequest('/raid-protection/audit/fix-all', {
    method: 'POST',
    guildId,
    silent: true,
    errorContext: 'API Error (Security Fix All):'
  });
}
