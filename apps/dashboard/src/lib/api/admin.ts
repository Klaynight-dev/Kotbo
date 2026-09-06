/** Administration du bot (instance globale). */
import { authStore } from '../stores/auth.svelte';
import { API_BASE_URL, BASE_URL, JSON_HEADERS, authorizedFetch, getGuildId, dashboardMutation } from './client';

export async function fetchAdminStats() {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/stats`);
  if (!response.ok) throw new Error('Erreur lors du chargement des statistiques admin');
  return response.json();
}

export async function fetchAdminModuleStats(options?: {
  guildId?: string;
  moduleName?: string;
  startDate?: string;
  endDate?: string;
  periodDays?: number;
  summary?: boolean;
}) {
  const params = new URLSearchParams();
  if (options?.guildId) params.set('guildId', options.guildId);
  if (options?.moduleName) params.set('moduleName', options.moduleName);
  if (options?.startDate) params.set('startDate', options.startDate);
  if (options?.endDate) params.set('endDate', options.endDate);
  if (options?.periodDays) params.set('period', options.periodDays.toString());
  if (options?.summary) params.set('summary', 'true');

  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/stats/modules?${params.toString()}`);
  if (!response.ok) throw new Error('Erreur lors du chargement des statistiques de modules');
  return response.json();
}

export async function fetchAdminGuilds() {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/guilds`);
  if (!response.ok) throw new Error('Erreur lors du chargement des serveurs');
  return response.json();
}

// ── Facturation globale ───────────────────────────────────────────────────────────────

export type AdminPlanKey = 'FREE' | 'PLUS' | 'PRO' | 'ULTIMATE' | 'CUSTOM';

export interface AdminBillingGuild {
  id: string;
  name: string | null;
  present: boolean;
  plan: AdminPlanKey;
  activated: boolean;
  accessType: string | null;
  accessExpiresAt: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripeSubscriptionStatus: string | null;
  stripeCurrentPeriodEnd: string | null;
  stripeCancelAtPeriodEnd: boolean;
  trial: {
    discordUserId: string;
    consumed: boolean;
    reservedAt: string;
    startedAt: string | null;
  } | null;
}

export interface AdminBillingState {
  enabled: boolean;
  plans: { key: AdminPlanKey; name: string }[];
  counts: Record<AdminPlanKey, number>;
  trialDays: number;
  subscriptions: number;
  trials: number;
  guilds: AdminBillingGuild[];
}

async function adminBillingMutation(path: string, method: 'PUT' | 'POST', body?: unknown) {
  const response = await authorizedFetch(`${API_BASE_URL}${path}`, {
    method,
    headers: JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Erreur lors de la mise à jour de la facturation');
  return result as { ok: boolean; message: string; plan?: AdminPlanKey; status?: string };
}

export async function fetchAdminBilling(): Promise<AdminBillingState> {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/billing`);
  if (!response.ok) throw new Error("Erreur lors du chargement de la facturation");
  return response.json();
}

export function setAdminGuildPlan(guildId: string, plan: AdminPlanKey, reason: string) {
  return adminBillingMutation(`/api/admin/guilds/${guildId}/plan`, 'PUT', { plan, reason });
}

export function detachAdminGuildBilling(guildId: string) {
  return adminBillingMutation(`/api/admin/guilds/${guildId}/billing/detach`, 'POST');
}

export function resetAdminGuildBillingTrial(guildId: string) {
  return adminBillingMutation(`/api/admin/guilds/${guildId}/billing/trial-reset`, 'POST');
}

export function resyncAdminGuildBilling(guildId: string) {
  return adminBillingMutation(`/api/admin/guilds/${guildId}/billing/resync`, 'POST');
}

export async function fetchAdminShards() {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/shards`);
  if (!response.ok) throw new Error('Erreur lors du chargement des shards');
  return response.json();
}

export async function restartAdminShard(shardId: number) {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/shards/${shardId}/restart`, { method: 'POST' });
  if (!response.ok) throw new Error('Erreur lors du redémarrage du shard');
  return response.json();
}

export async function restartAllAdminShards() {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/shards/restart-all`, { method: 'POST' });
  if (!response.ok) throw new Error('Erreur lors du redémarrage global');
  return response.json();
}

export async function reconfigureAdminShards(payload: { mode: 'auto' | 'fixed'; shardCount?: number | null }) {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/shards/reconfigure`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error('Erreur lors de la reconfiguration des shards');
  return response.json();
}

export async function fetchGlobalDailyAlgoLeaderboard() {
  const guildId = getGuildId();
  if (!guildId) return null;
  const response = await authorizedFetch(`${BASE_URL}/guilds/${guildId}/daily-algo-submissions/global-leaderboard`);
  if (!response.ok) return null;
  return response.json();
}

export async function fetchAdminGuildInvite(guildId: string) {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/guilds/${guildId}/invite`, { method: 'POST' });
  if (!response.ok) throw new Error("Erreur lors de la création de l'invitation");
  return response.json();
}

export async function leaveAdminGuild(guildId: string) {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/guilds/${guildId}/leave`, { method: 'POST' });
  if (!response.ok) throw new Error('Erreur lors du départ du serveur');
  return response.json();
}

export async function fetchGlobalAdmins() {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/admins`, { method: 'GET' });
  if (!response.ok) throw new Error('Erreur lors du chargement des admins globaux');
  return response.json();
}

export async function addGlobalAdmin(userId: string) {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/admins`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId })
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "Erreur lors de l'ajout de l'admin global");
  }
  return response.json();
}

export async function removeGlobalAdmin(userId: string) {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/admins/${userId}`, { method: 'DELETE' });
  if (!response.ok) throw new Error("Erreur lors de la suppression de l'admin global");
  return response.json();
}

export async function fetchGlobalBlacklist() {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/blacklist`, { method: 'GET' });
  if (!response.ok) throw new Error('Erreur chargement blacklist');
  return response.json();
}

export async function addGlobalBlacklist(userId: string, reason: string) {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/blacklist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, reason })
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "Erreur d'ajout blacklist");
  }
  return response.json();
}

export async function removeGlobalBlacklist(userId: string) {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/blacklist/${userId}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Erreur suppression blacklist');
  return response.json();
}

export interface GdprPreviewTable { key: string; label: string; count: number; }
export interface GdprPreviewCategory { key: string; label: string; description: string; count: number; tables: GdprPreviewTable[]; }
export interface GdprPreview {
  meta: { userId: string; username: string | null; globalName: string | null; generatedAt: string; totalRecords: number; guildCount: number; errors: string[]; };
  identity: { discordUser: Record<string, unknown> | null; guilds: { id: string; name: string }[]; staffMemberIds: string[]; };
  categories: GdprPreviewCategory[];
}

export async function fetchGdprPreview(userId: string): Promise<GdprPreview> {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/gdpr/${userId}/preview`, { method: 'GET' });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Erreur lors de la collecte des données RGPD');
  }
  return response.json();
}

export async function downloadGdprExport(userId: string): Promise<void> {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/gdpr/${userId}/export`, {
    method: 'GET',
    headers: { 'Accept': 'application/zip' },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "Erreur lors de la génération de l'archive");
  }
  const disposition = response.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="?([^"]+)"?/);
  const filename = match?.[1] || `kotbo_rgpd_${userId}.zip`;
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function fetchMaintenanceConfig() {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/config`, { method: 'GET' });
  if (!response.ok) throw new Error('Erreur chargement config');
  return response.json();
}

export async function updateMaintenanceConfig(maintenance: boolean) {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ maintenance })
  });
  if (!response.ok) throw new Error('Erreur maj maintenance');
  return response.json();
}

export async function fetchBotErrors() {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/errors`, { method: 'GET' });
  if (!response.ok) throw new Error('Erreur chargement erreurs');
  return response.json();
}

export async function clearBotErrors() {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/errors`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Erreur suppression erreurs');
  return response.json();
}

// ─── Broadcast System ───

export interface BroadcastPayload {
  title?: string;
  message: string;
  color?: string;
  thumbnailUrl?: string;
  imageUrl?: string;
  footerText?: string;
  target?: 'ALL' | 'ACTIVATED' | 'CUSTOM';
  targetGuilds?: string[];
  channelPref?: 'AUTO' | 'NEWS' | 'PUBLIC' | 'STAFF' | 'FALLBACK';
  dryRun?: boolean;
  /** ISO 8601. Present = annonce programmee au lieu d'un envoi immediat. */
  scheduledAt?: string;
}

export interface BroadcastGuildChannel {
  id: string;
  name: string;
  category: string | null;
  position: number;
}

export interface BroadcastGuildConfig {
  id: string;
  name: string;
  icon: string | null;
  memberCount: number;
  activated: boolean;
  broadcastChannelId: string | null;
  broadcastChannelName: string | null;
  channelStatus: 'OK' | 'MISSING' | 'UNSET';
  channels: BroadcastGuildChannel[];
}

export interface BroadcastDelivery {
  id: string;
  broadcastId: string;
  guildId: string;
  guildName: string;
  channelId: string | null;
  channelName: string | null;
  status: 'SENT' | 'FAILED' | 'SKIPPED';
  reason: string | null;
  messageId: string | null;
  createdAt: string;
}

export interface BroadcastResult {
  success: boolean;
  successCount: number;
  failCount: number;
  totalTargeted: number;
  dryRun?: boolean;
  scheduled?: boolean;
  scheduledAt?: string;
  broadcastId?: string;
  /** Avertissements non bloquants (image en HTTP, etc.). */
  warnings?: string[];
  /** Nombre de serveurs cibles sans salon de diffusion configure (simulation). */
  unconfiguredCount?: number;
  /** Echecs detailles, tronques a 50 entrees. */
  failures?: Omit<BroadcastDelivery, 'id' | 'broadcastId' | 'createdAt'>[];
}

export interface BroadcastLogEntry {
  id: string;
  sentBy: string;
  username?: string;
  avatarUrl?: string | null;
  title: string;
  message: string;
  color: string;
  thumbnailUrl: string | null;
  imageUrl: string | null;
  footerText: string | null;
  target: string;
  targetGuilds: string[];
  channelPref: string;
  successCount: number;
  failCount: number;
  totalTargeted: number;
  status: 'DRAFT' | 'SCHEDULED' | 'SENDING' | 'SENT' | 'CANCELLED' | 'FAILED';
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  cancelledBy: string | null;
  createdAt: string;
}

export interface BroadcastEmoji {
  key: string;
  discordName: string;
  formatted: string;
  unicode?: string;
}

export async function sendBroadcast(payload: BroadcastPayload): Promise<BroadcastResult> {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Erreur broadcast');
  }
  return response.json();
}

export async function fetchBroadcastHistory(limit = 20): Promise<{ logs: BroadcastLogEntry[] }> {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/broadcast?limit=${limit}`);
  if (!response.ok) throw new Error('Erreur chargement historique');
  return response.json();
}

export async function deleteBroadcastLog(id: string): Promise<void> {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/broadcast/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Erreur suppression');
}

export async function fetchBroadcastEmojis(): Promise<{ emojis: BroadcastEmoji[] }> {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/broadcast/emojis`);
  if (!response.ok) throw new Error('Erreur chargement emojis');
  return response.json();
}

export async function fetchBroadcastChannels(): Promise<{ guilds: BroadcastGuildConfig[] }> {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/broadcast/channels`);
  if (!response.ok) throw new Error('Erreur chargement des salons de diffusion');
  return response.json();
}

export async function setBroadcastChannel(guildId: string, channelId: string | null): Promise<void> {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/broadcast/channels/${guildId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Erreur lors de la configuration du salon');
  }
}

export async function updateRecruitmentConfig(payload: any, guildId: string = authStore.selectedGuildId) {
  return dashboardMutation('/recruitment/config', {
    method: 'PATCH',
    payload,
    guildId,
    errorContext: 'API Error (Update Recruitment Config):'
  });
}

export async function fetchActivationCodes() {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/activation-codes`, { method: 'GET' });
  if (!response.ok) throw new Error("Erreur lors du chargement des codes d'activation");
  return response.json();
}

export interface AccessGrant {
  /** PERMANENT : accès sans expiration. TRIAL/SUBSCRIPTION : nécessite durationMinutes. */
  accessType?: 'PERMANENT' | 'TRIAL' | 'SUBSCRIPTION';
  /** Durée en minutes, l'unité de stockage unique, du test de 30 min à l'essai de 15 jours. */
  durationMinutes?: number | null;
  label?: string | null;
}

export async function createActivationCode(grant: AccessGrant = {}) {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/activation-codes`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(grant),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.error || "Erreur lors de la génération du code d'activation");
  }
  return response.json();
}

export async function deleteActivationCode(id: string) {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/activation-codes/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error("Erreur lors de la suppression du code d'activation");
  return response.json();
}

export async function deactivateAdminGuild(guildId: string) {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/guilds/${guildId}/deactivate`, { method: 'POST' });
  if (!response.ok) throw new Error('Erreur lors de la désactivation du serveur');
  return response.json();
}

export async function activateAdminGuildAuto(guildId: string, grant: AccessGrant = {}) {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/guilds/${guildId}/activate-auto`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(grant),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.error || "Erreur lors de l'activation automatique du serveur");
  }
  return response.json();
}

/** Prolonge l'accès à durée limitée d'un serveur (geste commercial, renouvellement). */
export async function extendAdminGuildAccess(guildId: string, minutes: number, accessType?: AccessGrant['accessType']) {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/guilds/${guildId}/access/extend`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ minutes, accessType }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.error || "Erreur lors de la prolongation de l'accès");
  }
  return response.json();
}

export async function reconcileStaffServers() {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/staff-servers/reconcile`, { method: 'POST' });
  if (!response.ok) throw new Error('Erreur lors de la synchronisation des serveurs staff');
  return response.json();
}

export async function rescanAdminGuildStats(guildId: string, force = false) {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/guilds/${guildId}/rescan-stats`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ force })
  });
  if (!response.ok) throw new Error('Erreur lors du lancement du rescan des statistiques');
  return response.json();
}

export async function resyncAdminGuildData(guildId: string) {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/guilds/${guildId}/resync-all`, {
    method: 'POST',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.error || 'Erreur lors du lancement de la synchronisation complète');
  }
  return response.json();
}

export async function resetAdminGuildServerTemplate(guildId: string) {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/guilds/${guildId}/reset-server-template`, {
    method: 'POST',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.error || 'Erreur lors de la réinitialisation de la mise en place');
  }
  return response.json();
}

export async function activateGuildWithCode(code: string, guildId = authStore.selectedGuildId) {
  const token = authStore.token;
  if (!token) {
    throw new Error('No auth token available');
  }
  const response = await fetch(`${BASE_URL}/guilds/${guildId}/activate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ code })
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "Erreur lors de l'activation du serveur");
  }
  return response.json();
}

// ── Médias de broadcast ─────────────────────────────────────────────────────
// Discord ne charge ni les URL `data:` ni les liens CDN signés, qui expirent.
// L'upload passe donc par Kotbo, qui héberge l'image derrière une URL stable.

export interface BroadcastMedia {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  url: string;
  uploadedBy: string;
  usageCount: number;
  createdAt: string;
}

export interface BroadcastMediaLibrary {
  media: BroadcastMedia[];
  usedBytes: number;
  quotaBytes: number;
}

export const BROADCAST_MEDIA_MAX_BYTES = 8 * 1024 * 1024;
export const BROADCAST_MEDIA_ACCEPTED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** Lit un fichier en base64 nu (sans le préfixe `data:...;base64,`). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const separator = result.indexOf(',');
      resolve(separator >= 0 ? result.slice(separator + 1) : result);
    };
    reader.onerror = () => reject(new Error('Lecture du fichier impossible'));
    reader.readAsDataURL(file);
  });
}

export async function uploadBroadcastMedia(file: File): Promise<BroadcastMedia> {
  if (!BROADCAST_MEDIA_ACCEPTED.includes(file.type)) {
    throw new Error(`Format non supporté (${file.type || 'inconnu'}). Utilisez PNG, JPEG, GIF ou WEBP.`);
  }
  if (file.size > BROADCAST_MEDIA_MAX_BYTES) {
    throw new Error(`Image trop lourde : ${Math.round(BROADCAST_MEDIA_MAX_BYTES / 1024 / 1024)} Mo maximum.`);
  }

  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/broadcast/media`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      fileName: file.name,
      mimeType: file.type,
      data: await fileToBase64(file),
    }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "Erreur lors de l'upload de l'image");
  }
  return response.json();
}

export async function fetchBroadcastMedia(limit = 60): Promise<BroadcastMediaLibrary> {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/broadcast/media?limit=${limit}`);
  if (!response.ok) throw new Error('Erreur lors du chargement des images');
  return response.json();
}

export async function deleteBroadcastMedia(id: string): Promise<void> {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/broadcast/media/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error("Erreur lors de la suppression de l'image");
}

// ── Modèles d'annonce ───────────────────────────────────────────────────────

export interface BroadcastTemplate {
  id: string;
  name: string;
  title: string | null;
  message: string;
  color: string;
  thumbnailUrl: string | null;
  imageUrl: string | null;
  footerText: string | null;
  target: string;
  targetGuilds: string[];
  channelPref: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export async function fetchBroadcastTemplates(): Promise<{ templates: BroadcastTemplate[] }> {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/broadcast/templates`);
  if (!response.ok) throw new Error('Erreur lors du chargement des modèles');
  return response.json();
}

export async function createBroadcastTemplate(payload: BroadcastPayload & { name: string }): Promise<BroadcastTemplate> {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/broadcast/templates`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Erreur lors de la création du modèle');
  }
  return response.json();
}

export async function deleteBroadcastTemplate(id: string): Promise<void> {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/broadcast/templates/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Erreur lors de la suppression du modèle');
}

// ── Rapport de diffusion et annulation ──────────────────────────────────────

export async function fetchBroadcastDeliveries(
  broadcastId: string,
  status: 'ALL' | 'SENT' | 'FAILED' | 'SKIPPED' = 'ALL',
): Promise<{ deliveries: BroadcastDelivery[] }> {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/broadcast/${broadcastId}/deliveries?status=${status}`);
  if (!response.ok) throw new Error('Erreur lors du chargement du rapport de diffusion');
  return response.json();
}

export async function cancelScheduledBroadcast(broadcastId: string): Promise<void> {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/broadcast/${broadcastId}/cancel`, { method: 'POST' });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "Erreur lors de l'annulation");
  }
}

// ── Historique de santé ─────────────────────────────────────────────────────

export interface AdminHealthSample {
  t: number;
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  averagePing: number;
  onlineShards: number;
  totalShards: number;
  guilds: number;
  members: number;
  cpu: number;
  uptime: number;
}

export interface AdminHealthSeries {
  samples: AdminHealthSample[];
  intervalMs: number;
  heapTrendPerHour: number;
  peak: { heapUsed: number; rss: number; averagePing: number; cpu: number } | null;
}

export async function fetchAdminHealthSeries(minutes = 60): Promise<AdminHealthSeries> {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/health/series?minutes=${minutes}`);
  if (!response.ok) throw new Error("Erreur lors du chargement de l'historique de santé");
  return response.json();
}

// ── Journal d'audit ─────────────────────────────────────────────────────────

export interface AdminAuditEntry {
  id: string;
  actorId: string;
  actorName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  summary: string;
  metadata: unknown;
  outcome: 'OK' | 'FAILED';
  ip: string | null;
  createdAt: string;
}

export interface AdminAuditQuery {
  action?: string;
  actorId?: string;
  targetId?: string;
  outcome?: 'OK' | 'FAILED';
  search?: string;
  sinceHours?: number;
  limit?: number;
  cursor?: string;
}

export async function fetchAdminAudit(query: AdminAuditQuery = {}): Promise<{
  entries: AdminAuditEntry[];
  nextCursor: string | null;
}> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/audit?${params.toString()}`);
  if (!response.ok) throw new Error('Erreur lors du chargement du journal');
  return response.json();
}

export async function fetchAdminAuditActions(): Promise<{ actions: { action: string; count: number }[] }> {
  const response = await authorizedFetch(`${API_BASE_URL}/api/admin/audit/actions`);
  if (!response.ok) throw new Error('Erreur lors du chargement des actions');
  return response.json();
}
