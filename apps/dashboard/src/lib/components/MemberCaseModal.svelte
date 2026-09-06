<script lang="ts">
  import type { MemberCaseResponse } from '@kotbo/contracts';
  import FormInput from './FormInput.svelte';
  import { dashboardStore } from '../stores/dashboard.svelte';
  import { authStore } from '../stores/auth.svelte';
  import { toast } from '../stores/toast.svelte';
  import { confirmDialog } from '../stores/confirmDialog.svelte';
  import Papicon from './Papicon.svelte';
  import Chart from './charts/Chart.svelte';
  import { inviteDetailsModal } from '../stores/inviteDetailsModal.svelte';
  import { channelDetailsModal } from '../stores/channelDetailsModal.svelte';
  import { fetchMemberCase, fetchMemberDetailedAnalytics, updateSanctionReport, linkMemberAccount, unlinkMemberAccount, updateMemberNote, runMemberCaseAction, searchMessages, fetchMessageLogChannels } from '../api';
  import { toDateTimeLocal, typeLabel as formatTypeLabel } from '../sanctions/formatters';
  import { buildReportRuleOptions, getRuleIdsFromBrokenRules, getRulesFromBrokenRules, buildBrokenRulesPayload } from '../sanctions/reportRules';
  import SelectedRuleChips from './sanctions/SelectedRuleChips.svelte';
  import EvidenceInputList from './sanctions/EvidenceInputList.svelte';
  import ReportRuleSelector from './sanctions/ReportRuleSelector.svelte';
  import { normalizeEvidenceLinks, sanitizeEvidenceLinks } from '../sanctions/evidenceLinks';
  import InteractionTree from './charts/InteractionTree.svelte';
  import Modal from './Modal.svelte';
  import { m, dateLocale } from '../i18n';
  import { renderLogHtml } from '../logDetails';

  type MemberCaseTab = 'resume' | 'identite' | 'activite' | 'messages' | 'logs' | 'sanctions' | 'invites' | 'connexions' | 'analytics' | 'candidatures' | 'linked_accounts' | 'notes';

  type MemberAnalyticsResponse = {
    totalMessages: number;
    totalVoiceMinutes: number;
    activeDays: number;
    period: number;
    dailyTrend: Array<{ dateKey: string; messages: number; voiceMinutes: number }>;
  };

  let {
    open = $bindable(false),
    userName = '',
    userId = null as string | null,
    caseData = null as MemberCaseResponse | null,
    loading = false,
    error = '',
    actionReason = $bindable(''),
    actionDuration = $bindable('30m'),
    actionBusy = false,
    actionFeedback = '',
    actionIsError = false,
    onClose = () => {},
    onSelectUser = (_userId: string) => {},
  } = $props<{
    open?: boolean;
    userName?: string;
    userId?: string | null;
    caseData?: MemberCaseResponse | null;
    loading?: boolean;
    error?: string;
    actionReason?: string;
    actionDuration?: string;
    actionBusy?: boolean;
    actionFeedback?: string;
    actionIsError?: boolean;
    onClose?: (e: MouseEvent) => void;
    onAction?: (action: 'WARN' | 'KICK' | 'TIMEOUT' | 'BAN') => void;
    onSelectUser?: (userId: string) => void;
  }>();

  let activeTab = $state<MemberCaseTab>('resume');
  let analyticsData = $state<MemberAnalyticsResponse | null>(null);
  let analyticsLoading = $state(false);

  // --- NOUVEAUX ÉTATS POUR L'ONGLET MESSAGES ---
  let messageQuery = $state('');
  let messageChannelId = $state('');
  let messageIncludeDeleted = $state(true);
  const messageLimit = $state(20);
  let messageOffset = $state(0);
  let messageFrom = $state('');
  let messageTo = $state('');

  let messagesList = $state<any[]>([]);
  let messagesTotalCount = $state(0);
  let messagesLoading = $state(false);
  let messagesChannels = $state<any[]>([]);

  // --- FILTRES DE L'ONGLET LOGS ---
  // Les logs arrivent deja entiers dans caseData (le serveur en plafonne le
  // nombre), le filtrage est donc local et instantane : pas d'aller-retour.
  let logQuery = $state('');
  let logModule = $state('');
  let logSource = $state('');
  let logFrom = $state('');
  let logTo = $state('');
  let logOrder = $state<'desc' | 'asc'>('desc');

  const logModules = $derived(
    [...new Set((caseData?.logs ?? []).map((log: any) => log.module).filter(Boolean))].sort(
      (a: any, b: any) => String(a).localeCompare(String(b), 'fr'),
    ),
  );
  const logSources = $derived(
    [...new Set((caseData?.logs ?? []).map((log: any) => log.source).filter(Boolean))].sort(
      (a: any, b: any) => String(a).localeCompare(String(b), 'fr'),
    ),
  );

  const filteredLogs = $derived.by(() => {
    const query = logQuery.trim().toLowerCase();
    // Bornes inclusives : `to` couvre la journee entiere.
    const from = logFrom ? new Date(`${logFrom}T00:00:00`).getTime() : null;
    const to = logTo ? new Date(`${logTo}T23:59:59.999`).getTime() : null;

    const matching = (caseData?.logs ?? []).filter((log: any) => {
      if (logModule && log.module !== logModule) return false;
      if (logSource && log.source !== logSource) return false;
      if (from !== null || to !== null) {
        const at = new Date(log.dateIso).getTime();
        if (Number.isNaN(at)) return false;
        if (from !== null && at < from) return false;
        if (to !== null && at > to) return false;
      }
      if (!query) return true;
      return [log.action, log.module, log.source, log.details]
        .some((field) => String(field ?? '').toLowerCase().includes(query));
    });

    return matching.toSorted(
      (a: any, b: any) => {
        const delta = new Date(a.dateIso).getTime() - new Date(b.dateIso).getTime();
        return logOrder === 'asc' ? delta : -delta;
      },
    );
  });

  // --- CALCUL DES STATISTIQUES RICHES DÉRIVÉES ---
  const moderationRiskScore = $derived.by(() => {
    let score = 0;
    if (!caseData) return 0;
    if (caseData.isSuspectedDC || caseData.profile?.isSuspectedDC) score += 30;
    const activeSanctions = caseData.sanctions?.filter(s => s.status === 'ACTIVE') || [];
    const pastSanctions = caseData.sanctions?.filter(s => s.status !== 'ACTIVE') || [];
    score += activeSanctions.length * 25;
    score += pastSanctions.length * 10;
    if (caseData.linkedAccounts && caseData.linkedAccounts.length > 0) {
      score += caseData.linkedAccounts.length * 15;
    }
    return Math.min(100, score);
  });

  const memberSeniority = $derived.by(() => {
    if (!caseData?.profile?.guildJoinedAt) return m.mcm_seniority_newcomer();
    const joined = new Date(caseData.profile.guildJoinedAt).getTime();
    const ageDays = (Date.now() - joined) / (1000 * 60 * 60 * 24);
    if (ageDays > 365) return m.mcm_seniority_veteran();
    if (ageDays > 180) return m.mcm_seniority_old();
    if (ageDays > 30) return m.mcm_seniority_regular();
    if (ageDays > 7) return m.mcm_seniority_recent();
    return m.mcm_seniority_newcomer();
  });

  const topChannels = $derived.by(() => {
    if (!caseData?.messagesByChannel) return [];
    return [...caseData.messagesByChannel]
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
  });

  // --- FONCTIONS DE CHARGEMENT ET D'ACTION ---
  async function loadMemberMessages() {
    if (!userId) return;
    messagesLoading = true;
    try {
      const data = await searchMessages({
        authorId: userId,
        q: messageQuery.trim() || undefined,
        channelId: messageChannelId || undefined,
        includeDeleted: messageIncludeDeleted,
        from: messageFrom || undefined,
        to: messageTo || undefined,
        limit: messageLimit,
        offset: messageOffset,
        order: 'desc'
      });
      messagesList = data.messages || [];
      messagesTotalCount = data.total || 0;
    } catch (e) {
      console.error('Failed to load member messages:', e);
    } finally {
      messagesLoading = false;
    }
  }

  async function loadMemberMessageChannels() {
    if (!userId) return;
    try {
      messagesChannels = await fetchMessageLogChannels(undefined, userId);
    } catch (e) {
      console.error('Failed to load member message channels:', e);
    }
  }

  function parseDurationToMs(durationStr: string): number {
    const match = durationStr.match(/^(\d+)([smhd])$/i);
    if (!match) return 30 * 60 * 1000;
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    switch (unit) {
      case 's': return value * 1000;
      case 'm': return value * 60 * 1000;
      case 'h': return value * 60 * 60 * 1000;
      case 'd': return value * 24 * 60 * 60 * 1000;
      default: return value * 60 * 1000;
    }
  }

  async function executeModerationAction(action: 'WARN' | 'KICK' | 'TIMEOUT' | 'BAN') {
    if (!userId) return;
    
    const reasonText = actionReason.trim() || m.mcm_default_reason();
    let confirmTitle = '';
    let confirmDesc = '';
    let confirmLabel = '';
    let variant: 'danger' | 'warning' = 'warning';
    
    if (action === 'WARN') {
      confirmTitle = m.mcm_confirm_warn_title({ name: userName });
      confirmDesc = m.mcm_confirm_warn_desc({ reason: reasonText });
      confirmLabel = m.mcm_action_warn();
    } else if (action === 'TIMEOUT') {
      confirmTitle = m.mcm_confirm_timeout_title({ name: userName });
      confirmDesc = m.mcm_confirm_timeout_desc({ duration: actionDuration, reason: reasonText });
      confirmLabel = m.mcm_action_exclude();
    } else if (action === 'KICK') {
      confirmTitle = m.mcm_confirm_kick_title({ name: userName });
      confirmDesc = m.mcm_confirm_kick_desc({ reason: reasonText });
      confirmLabel = m.mcm_action_kick();
      variant = 'danger';
    } else if (action === 'BAN') {
      confirmTitle = m.mcm_confirm_ban_title({ name: userName });
      confirmDesc = m.mcm_confirm_ban_desc({ reason: reasonText });
      confirmLabel = m.mcm_action_ban();
      variant = 'danger';
    }
    
    const confirmed = await confirmDialog.ask({
      title: confirmTitle,
      description: confirmDesc,
      confirmLabel,
      variant
    });
    
    if (!confirmed) return;
    
    actionBusy = true;
    actionFeedback = '';
    actionIsError = false;
    
    try {
      const payload: { reason: string; durationMs?: number | null } = {
        reason: reasonText
      };
      
      if (action === 'TIMEOUT') {
        payload.durationMs = parseDurationToMs(actionDuration);
      }
      
      const res = await runMemberCaseAction(userId, action, payload);
      if (res?.ok) {
        toast.success(m.mcm_action_done({ action }));
        actionReason = '';
        // Recharger le dossier membre
        const updatedCase = await fetchMemberCase(userId);
        if (updatedCase) {
          caseData = updatedCase;
        }
      } else {
        throw new Error(res?.error || m.mcm_action_error());
      }
    } catch (err: any) {
      actionIsError = true;
      actionFeedback = err?.message || m.mcm_action_error_generic();
      toast.error(actionFeedback);
    } finally {
      actionBusy = false;
    }
  }
  let viewingReportSanctionId = $state<string | null>(null);
  let isEditingReport = $state(false);
  let updateReportBusy = $state(false);
  let editReportData = $state({
    incidentAt: '',
    sanctionDurationLabel: '',
    selectedRuleIds: [] as string[],
    detailedReason: '',
    evidenceLinks: [] as string[],
    additionalNotes: ''
  });

  let requestVerificationBusy = $state(false);

  // Historique des vérifications : un modérateur doit voir d'un coup d'oeil
  // qu'un collègue en a déjà demandé une, et depuis quand (issue #216).
  const verifications = $derived(caseData?.verifications ?? null);
  const verificationEntries = $derived(verifications?.entries ?? []);
  const verificationCount = $derived(verifications?.total ?? 0);
  const verificationPending = $derived(verifications?.hasPending ?? false);
  const verificationCooldownUntil = $derived(
    verifications?.cooldownUntil ? new Date(verifications.cooldownUntil) : null
  );
  // Recalculé à chaque rendu du modal : suffisant ici, le staff rouvre la fiche
  // plutôt que de fixer le bouton en attendant la fin du délai.
  const verificationBlocked = $derived(
    verificationPending
    || (verificationCooldownUntil !== null && verificationCooldownUntil.getTime() > Date.now())
  );

  function formatVerificationDate(value: string | null | undefined): string {
    if (!value) return m.mcm_verif_never();
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return m.mcm_verif_never();
    return date.toLocaleString(dateLocale(), {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  const VERIFICATION_STATUS_STYLES: Record<string, string> = {
    VERIFIED: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
    PENDING: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
    FLAGGED: 'bg-rose-500/10 text-rose-500 border-rose-500/20',
    EXPIRED: 'bg-on-surface/5 text-on-surface-variant/60 border-outline-variant/20',
  };

  function verificationStatusLabel(status: string): string {
    switch (status) {
      case 'VERIFIED': return m.mcm_verif_status_verified();
      case 'PENDING': return m.mcm_verif_status_pending();
      case 'FLAGGED': return m.mcm_verif_status_flagged();
      default: return m.mcm_verif_status_expired();
    }
  }

  async function handleRequestVerification() {
    if (!userId) return;
    if (verificationBlocked) {
      toast.error(verificationPending ? m.mcm_verif_already_pending() : m.mcm_verif_cooldown());
      return;
    }
    if (!(await confirmDialog.ask({ title: m.mcm_verif_title(), description: m.mcm_verif_desc(), confirmLabel: m.mcm_verif_confirm(), variant: 'warning' }))) return;
    requestVerificationBusy = true;
    try {
      const res = await runMemberCaseAction(userId, 'REQUEST_VERIFICATION', {
        reason: m.mcm_verif_reason()
      });
      toast.success(m.mcm_verif_sent());
      const updatedCase = await fetchMemberCase(userId);
      if (updatedCase) caseData = updatedCase;
    } catch (err: any) {
      toast.error(err?.message || m.mcm_error_request());
    } finally {
      requestVerificationBusy = false;
    }
  }

  let targetAccountId = $state('');
  let linkReason = $state('');
  let linkBusy = $state(false);
  let linkFeedback = $state('');
  let linkIsError = $state(false);

  async function handleLinkAccount() {
    if (!targetAccountId.trim()) {
      linkIsError = true;
      linkFeedback = m.mcm_error_id_required();
      return;
    }

    linkBusy = true;
    linkFeedback = '';
    linkIsError = false;

    try {
      const success = await linkMemberAccount(userId!, targetAccountId, linkReason);
      if (success) {
        linkIsError = false;
        linkFeedback = m.mcm_link_success();
        targetAccountId = '';
        linkReason = '';
        if (userId) {
          const updatedCase = await fetchMemberCase(userId);
          if (updatedCase) {
            caseData = updatedCase;
          }
        }
      } else {
        linkIsError = true;
        linkFeedback = m.mcm_link_error();
      }
    } catch (e: any) {
      linkIsError = true;
      linkFeedback = e.message || m.mcm_error_unexpected_long();
    } finally {
      linkBusy = false;
    }
  }

  /**
   * Suggestions « ce compte est déjà lié à X sur d'autres serveurs ».
   * Les liens déjà reproduits ici restent affichés (en confirmation), mais ne
   * proposent plus de bouton d'action.
   */
  const crossServerLinks = $derived(caseData?.crossServerLinks ?? null);
  const crossServerLinkSuggestions = $derived(crossServerLinks?.suggestions ?? []);
  const pendingCrossServerLinks = $derived(crossServerLinkSuggestions.filter((s) => !s.alreadyLinkedHere));

  let applyingSuggestionId = $state<string | null>(null);

  /** Reproduit ici un lien déjà posé ailleurs, en traçant sa provenance dans la raison. */
  async function handleApplySuggestedLink(suggestion: { userId: string; serverCount: number; guilds: { guildName: string }[] }) {
    if (applyingSuggestionId) return;
    applyingSuggestionId = suggestion.userId;

    const servers = suggestion.guilds.map((g) => g.guildName).join(', ');
    try {
      const success = await linkMemberAccount(
        userId!,
        suggestion.userId,
        m.mcm_xlink_apply_reason({ count: suggestion.serverCount, servers }),
      );
      if (success) {
        toast.success(m.mcm_link_success());
        if (userId) {
          const updatedCase = await fetchMemberCase(userId);
          if (updatedCase) caseData = updatedCase;
        }
      } else {
        toast.error(m.mcm_link_error());
      }
    } catch (e: any) {
      toast.error(e.message || m.mcm_error_unexpected_long());
    } finally {
      applyingSuggestionId = null;
    }
  }

  let unlinkingAccountId = $state<string | null>(null);

  async function handleUnlinkAccount(targetId: string) {
    if (!(await confirmDialog.ask({ title: m.mcm_unlink_title(), confirmLabel: m.mcm_unlink_confirm(), variant: 'warning' }))) return;
    unlinkingAccountId = targetId;

    try {
      const success = await unlinkMemberAccount(userId!, targetId);
      if (success) {
        if (userId) {
          const updatedCase = await fetchMemberCase(userId);
          if (updatedCase) {
            caseData = updatedCase;
          }
        }
      } else {
        toast.error(m.mcm_error_unlink());
      }
    } catch (e: any) {
      toast.error(e.message || m.mcm_error_unexpected());
    } finally {
      unlinkingAccountId = null;
    }
  }

  let moderatorNote = $state('');
  let noteBusy = $state(false);
  let noteFeedback = $state('');

  $effect(() => {
    if (caseData?.profile?.moderatorNote !== undefined) {
      moderatorNote = caseData?.profile?.moderatorNote ?? '';
    }
  });

  async function handleSaveNote() {
    if (!userId) return;
    noteBusy = true;
    noteFeedback = '';
    try {
      const result = await updateMemberNote(userId, moderatorNote);
      if (result?.ok) {
        noteFeedback = m.mcm_note_saved();
        if (caseData?.profile) {
          caseData.profile.moderatorNote = moderatorNote;
        }
      } else {
        noteFeedback = m.mcm_error_save();
      }
    } catch (e) {
      noteFeedback = m.mcm_error_save();
    } finally {
      noteBusy = false;
    }
  }

  function startEditingReport(report: any) {
    editReportData = {
      incidentAt: toDateTimeLocal(report.incidentAt),
      sanctionDurationLabel: report.sanctionDurationLabel || '',
      selectedRuleIds: getRuleIdsFromBrokenRules(report.brokenRules),
      detailedReason: report.detailedReason,
      evidenceLinks: normalizeEvidenceLinks(report.evidenceLinks, true),
      additionalNotes: report.additionalNotes || ''
    };
    isEditingReport = true;
  }

  async function handleUpdateReport() {
    if (!viewingReportSanctionId || !selectedReport) return;
    updateReportBusy = true;

    try {
      const success = await updateSanctionReport(selectedReport.id, {
        incidentAt: new Date(editReportData.incidentAt).toISOString(),
        sanctionDurationLabel: editReportData.sanctionDurationLabel.trim(),
        brokenRules: buildBrokenRulesPayload(editReportData.selectedRuleIds, reportRuleOptions),
        detailedReason: editReportData.detailedReason,
        evidenceLinks: sanitizeEvidenceLinks(editReportData.evidenceLinks),
        additionalNotes: editReportData.additionalNotes.trim() || null
      });

      if (success) {
        // We rely on broadcastDashboardStateChange to refresh the data
        // But for immediate feedback, we can close the edit mode
        isEditingReport = false;
        // Optionally, update the local caseData if we want to be fast
        if (caseData?.sanctionReports) {
          const idx = caseData.sanctionReports.findIndex(r => r.id === selectedReport.id);
          if (idx !== -1) {
            caseData.sanctionReports[idx] = {
              ...caseData.sanctionReports[idx],
              incidentAt: new Date(editReportData.incidentAt).toISOString(),
              sanctionDurationLabel: editReportData.sanctionDurationLabel.trim(),
              brokenRules: buildBrokenRulesPayload(editReportData.selectedRuleIds, reportRuleOptions),
              detailedReason: editReportData.detailedReason,
              evidenceLinks: sanitizeEvidenceLinks(editReportData.evidenceLinks),
              additionalNotes: editReportData.additionalNotes.trim() || null
            };
          }
        }
      }
    } catch (e) {
      console.error('Failed to update sanction report:', e);
    } finally {
      updateReportBusy = false;
    }
  }


  const sanctions = $derived(
    caseData?.sanctions
      ? [...caseData.sanctions].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      : []
  );

  const crossServer = $derived(caseData?.crossServerSanctions ?? null);
  const crossServerBreakdown = $derived(
    crossServer
      ? Object.entries(crossServer.breakdown).filter(([, count]) => (count as number) > 0)
      : []
  );

  // Icône Papicon + classes de couleur (statiques pour Tailwind) par type de sanction.
  function getSanctionTypeStyle(type: string): { icon: string; tile: string; dot: string } {
    switch (type.toUpperCase()) {
      case 'WARN': return { icon: 'alert-triangle', tile: 'bg-amber-500/10 text-amber-500', dot: 'bg-amber-500' };
      case 'TIMEOUT': return { icon: 'clock', tile: 'bg-sky-500/10 text-sky-500', dot: 'bg-sky-500' };
      case 'KICK': return { icon: 'log-out', tile: 'bg-orange-500/10 text-orange-500', dot: 'bg-orange-500' };
      case 'TEMP_BAN': return { icon: 'ban', tile: 'bg-rose-500/10 text-rose-500', dot: 'bg-rose-500' };
      case 'BAN': return { icon: 'gavel', tile: 'bg-rose-600/10 text-rose-600', dot: 'bg-rose-600' };
      case 'SOFTBAN': return { icon: 'eraser', tile: 'bg-slate-500/10 text-slate-500', dot: 'bg-slate-500' };
      default: return { icon: 'shield', tile: 'bg-slate-500/10 text-slate-500', dot: 'bg-slate-500' };
    }
  }

  const reportRuleOptions = $derived(buildReportRuleOptions(dashboardStore.state.regulationRules || []));
  const selectedSanctionForReport = $derived(sanctions.find(s => s.id === viewingReportSanctionId) || null);
  const selectedReport = $derived(
    viewingReportSanctionId 
      ? [...(dashboardStore.state.sanctionReports || []), ...(caseData?.sanctionReports || [])].find(r => r.sanctionId === viewingReportSanctionId) || null
      : null
  );
  const selectedReportRules = $derived(
    selectedReport ? getRulesFromBrokenRules(selectedReport.brokenRules, reportRuleOptions) : []
  );
  const editDraftRules = $derived(
    editReportData.selectedRuleIds
      .map(id => reportRuleOptions.find(r => r.id === id))
      .filter((r): r is any => !!r)
  );

  const tabs: { id: MemberCaseTab; label: string; icon: string; count?: () => number }[] = $derived([
    { id: 'resume', label: m.mcm_tab_summary(), icon: 'layout' },
    { id: 'identite', label: m.mcm_tab_identity(), icon: 'user' },
    { id: 'activite', label: m.mcm_tab_activity(), icon: 'trending-up' },
    { id: 'analytics', label: m.mcm_tab_analytics(), icon: 'bar-chart-2' },
    { id: 'messages', label: m.mcm_tab_messages(), icon: 'message-square', count: () => caseData?.recentMessageCount ?? 0 },
    { id: 'logs', label: m.mcm_tab_logs(), icon: 'history', count: () => caseData?.recentLogCount ?? 0 },
    { id: 'sanctions', label: m.mcm_tab_sanctions(), icon: 'hammer', count: () => sanctions.length },
    { id: 'candidatures', label: m.mcm_tab_candidates(), icon: 'user-check', count: () => caseData?.candidatures?.length ?? 0 },
    { id: 'invites', label: m.mcm_tab_invites(), icon: 'mail' },
    { id: 'connexions', label: m.mcm_tab_connections(), icon: 'link' },
    { id: 'linked_accounts', label: m.mcm_tab_linked(), icon: 'link-2', count: () => (caseData?.linkedAccounts?.length ?? 0) + pendingCrossServerLinks.length },
    { id: 'notes', label: m.mcm_tab_notes(), icon: 'edit-3' },
  ]);

  function formatDateTime(value: string | null | undefined) {
    if (!value) return 'Inconnu';
    return new Date(value).toLocaleString(dateLocale());
  }

  function formatDateShort(value: string | null | undefined) {
    if (!value) return '-';
    return new Date(value).toLocaleDateString(dateLocale(), { day: '2-digit', month: 'short', year: 'numeric' });
  }


  function formatDurationFromSeconds(seconds: number | null | undefined) {
    if (!seconds || seconds <= 0) return '0s';
    const totalSeconds = Math.floor(seconds);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const parts: string[] = [];
    if (days) parts.push(`${days}j`);
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (parts.length === 0) parts.push(`${totalSeconds}s`);
    return parts.join(' ');
  }

  function formatRelative(value: string | null | undefined) {
    if (!value) return m.mcm_never();
    const date = new Date(value);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (seconds < 60) return m.mcm_just_now();
    if (minutes < 60) return m.mcm_ago_minutes({ n: minutes });
    if (hours < 24) return m.mcm_ago_hours({ n: hours });
    if (days < 7) return m.mcm_ago_days({ n: days });
    return date.toLocaleDateString(dateLocale(), { day: '2-digit', month: 'short' });
  }

  function getDurationSince(value: string | null | undefined) {
    if (!value) return m.mcm_unknown();
    const start = new Date(value);
    const now = new Date();
    let years = now.getFullYear() - start.getFullYear();
    let months = now.getMonth() - start.getMonth();
    
    if (months < 0) {
      years--;
      months += 12;
    }

    const parts: string[] = [];
    if (years > 0) parts.push(years > 1 ? m.mcm_years_other({ n: years }) : m.mcm_years_one({ n: years }));
    if (months > 0) parts.push(m.mcm_months({ n: months }));

    if (parts.length === 0) {
       const days = Math.floor((now.getTime() - start.getTime()) / 86400000);
       if (days <= 0) return m.mcm_today();
       return days > 1 ? m.mcm_days_other({ n: days }) : m.mcm_days_one({ n: days });
    }
    
    return parts.join(', ');
  }


  function getPresenceColor(status: string | null | undefined) {
    if (!status) return 'bg-slate-400';
    const s = status.toLowerCase();
    if (s === 'left') return 'bg-rose-500';
    if (s === 'online') return 'bg-emerald-500';
    if (s === 'idle') return 'bg-amber-500';
    if (s === 'dnd') return 'bg-red-500';
    return 'bg-slate-400';
  }

  function getPresenceLabel(status: string | null | undefined) {
    if (!status) return m.mcm_presence_offline();
    const s = status.toLowerCase();
    if (s === 'left') return m.mcm_presence_left();
    if (s === 'online') return m.mcm_presence_online();
    if (s === 'idle') return m.mcm_presence_idle();
    if (s === 'dnd') return m.mcm_presence_dnd();
    return m.mcm_presence_offline();
  }

  const logSnippetLabels = $derived({
    unknownChannel: m.lg_unknown_channel_name(),
    unknownRole: 'role-inconnu',
  });

  /**
   * `log.details` reprend mot pour mot ce qu'un membre a ecrit : le fragment
   * doit etre echappe avant de rejoindre le `{@html}` du journal.
   */
  function renderLogSnippet(value: string) {
    return renderLogHtml(value.replace(/^Contenu:\s*/i, '').trim(), logSnippetLabels);
  }

  function getConnectionIcon(type: string) {
    const t = type.toLowerCase();
    if (t === 'youtube') return 'video';
    if (t === 'twitch') return 'tv';
    if (t === 'twitter' || t === 'x') return 'twitter';
    if (t === 'spotify') return 'music';
    if (t === 'github') return 'github';
    if (t === 'steam') return 'gamepad';
    if (t === 'reddit') return 'message-square';
    if (t === 'instagram') return 'instagram';
    if (t === 'facebook') return 'facebook';
    if (t === 'tiktok') return 'play';
    if (t === 'playstation' || t === 'xbox' || t === 'battlenet' || t === 'epicgames' || t === 'riotgames') return 'gamepad';
    return 'link';
  }


  function getSanctionStatusLabel(status: string) {
    const s = status.toUpperCase();
    if (s === 'ACTIVE') return m.mcm_status_active();
    if (s === 'RESOLVED') return m.mcm_status_resolved();
    if (s === 'EXPIRED') return m.mcm_status_expired();
    return status;
  }

  async function loadMemberAnalytics() {
    if (!userId || !authStore.selectedGuildId) return;
    analyticsLoading = true;
    try {
      analyticsData = await fetchMemberDetailedAnalytics(userId, 30);
    } catch (e) {
      console.error('Failed to load member analytics:', e);
    } finally {
      analyticsLoading = false;
    }
  }

  $effect(() => {
    if (open) {
      activeTab = 'resume';
      messageQuery = '';
      messageChannelId = '';
      messageIncludeDeleted = true;
      messageOffset = 0;
      messageFrom = '';
      messageTo = '';
      messagesList = [];
      messagesTotalCount = 0;
      void loadMemberAnalytics();
    }
  });

  $effect(() => {
    if (open && activeTab === 'messages' && userId) {
      void loadMemberMessageChannels();
    }
  });

  $effect(() => {
    if (open && activeTab === 'messages' && userId) {
      // dependances reactives pour forcer la mise a jour
      const _q = messageQuery;
      const _c = messageChannelId;
      const _d = messageIncludeDeleted;
      const _f = messageFrom;
      const _t = messageTo;
      const _o = messageOffset;
      const _l = messageLimit;
      void loadMemberMessages();
    }
  });
</script>

<Modal
  open={open}
  onClose={onClose}
  size="screen"
  showCloseButton={false}
>
  <div class="font-body" role="dialog" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>

    <!-- ── Hero Section ──────────────────────────────────────── -->
    <div class="relative overflow-hidden" style="min-height: 180px;">
      {#if caseData?.profile?.bannerUrl}
        <div class="absolute inset-0" style="background-image: linear-gradient(to bottom, transparent 30%, var(--surface-container-lowest) 100%), url('{caseData.profile.bannerUrl}'); background-size: cover; background-position: center;"></div>
      {:else}
        <!-- Vagues colorées style kotbo.fr -->
        <div class="absolute inset-0" style="background: linear-gradient(135deg, #f97316 0%, #f472b6 35%, #a855f7 65%, #7c3aed 100%);"></div>
        <svg class="absolute inset-0 h-full w-full" viewBox="0 0 900 200" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="hero-w1" x1="0" y1="0" x2="1" y2="0.8">
              <stop offset="0%" stop-color="#fdba74" />
              <stop offset="100%" stop-color="#f9a8d4" />
            </linearGradient>
            <linearGradient id="hero-w2" x1="0" y1="0" x2="1" y2="0.5">
              <stop offset="0%" stop-color="#e879f9" stop-opacity="0.6" />
              <stop offset="100%" stop-color="#8b5cf6" stop-opacity="0.8" />
            </linearGradient>
            <linearGradient id="hero-w3" x1="0.2" y1="0" x2="0.8" y2="1">
              <stop offset="0%" stop-color="#c084fc" stop-opacity="0.4" />
              <stop offset="100%" stop-color="#6d28d9" stop-opacity="0.7" />
            </linearGradient>
          </defs>
          <path d="M0,40 C100,80 250,10 400,55 C550,100 720,25 900,65 L900,0 L0,0 Z" fill="url(#hero-w1)" opacity="0.7" />
          <path d="M0,110 C180,60 320,140 520,85 C700,30 820,95 900,55 L900,200 L0,200 Z" fill="url(#hero-w2)" />
          <path d="M0,155 C200,125 380,165 580,130 C740,100 850,145 900,115 L900,200 L0,200 Z" fill="url(#hero-w3)" />
        </svg>
      {/if}
      <div class="absolute inset-0 bg-linear-to-b from-transparent via-transparent to-(--surface-container-lowest)"></div>

      <!-- Avatar + Identity block -->
      <div class="relative z-10 flex items-end gap-5 px-8 pb-5 pt-20">
        <div class="relative shrink-0">
          <div class="absolute -inset-1.5 rounded-xl bg-white/20 blur-lg animate-pulse"></div>
          {#if caseData?.profile?.avatarUrl}
            <img
              src={caseData?.profile?.avatarUrl}
              alt={m.mcm_avatar_alt()}
              class="relative h-20 w-20 rounded-lg border-4 border-(--surface-container-lowest) object-cover shadow-sm"
            />
          {:else}
            <div class="relative flex h-20 w-20 items-center justify-center rounded-lg border-4 border-(--surface-container-lowest) bg-(--surface-container-high) text-2xl font-semibold text-primary shadow-sm">
              {userName.slice(0, 1).toUpperCase()}
            </div>
          {/if}
          <!-- Presence indicator -->
          <div class="absolute -bottom-1 -right-1 h-5 w-5 rounded-full border-3 border-(--surface-container-lowest) {getPresenceColor(caseData?.profile?.presenceStatus)}" title={getPresenceLabel(caseData?.profile?.presenceStatus)}></div>
        </div>

        <div class="min-w-0 pb-1">
          <h3 id="member-case-title" class="text-2xl font-semibold text-on-surface tracking-tight truncate font-headline">
            {caseData?.profile?.displayName || caseData?.profile?.globalName || userName}
          </h3>
          <div class="mt-1 flex flex-wrap items-center gap-2">
            <span class="text-sm font-semibold text-on-surface-variant/80">
              @{caseData?.profile?.username || userName}
            </span>
            {#if caseData?.profile?.isBot}
              <span class="badge badge-info">Bot</span>
            {/if}
            {#if caseData?.profile?.pronouns}
              <span class="badge badge-neutral">{caseData?.profile?.pronouns}</span>
            {/if}
            <span class="badge badge-neutral">
              <span class="h-2 w-2 rounded-full {getPresenceColor(caseData?.profile?.presenceStatus)}"></span>
              {getPresenceLabel(caseData?.profile?.presenceStatus)}
            </span>
            {#if caseData?.profile?.isTutor}
              <span class="badge bg-indigo-500/15 text-indigo-400 border border-indigo-500/30 shadow-sm animate-in zoom-in-95 duration-500">
                <Papicon icon="shield" size={12} class="mr-1" />
                {m.mcm_tutor_badge()}
              </span>
            {/if}
            {#if caseData?.profile?.staffGrade}
              <span class="badge bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 dark:border-amber-400/20 shadow-sm animate-in zoom-in-95 duration-500">
                <Papicon icon="star" size={12} class="mr-1" />
                {caseData?.profile?.staffGrade}
              </span>
            {/if}
            {#if userId}
              <div class="ml-auto flex items-center gap-2">
                <!-- Un collègue est peut-être déjà passé par là : l'état saute
                     aux yeux avant même d'ouvrir l'onglet Identité. -->
                {#if verificationPending}
                  <span class="badge border border-amber-400/30 bg-amber-500/20 text-amber-100 shadow-sm">
                    <Papicon icon="clock" size={12} class="mr-1" />
                    {m.mcm_verif_badge_pending()}
                  </span>
                {:else if verifications?.lastVerifiedAt}
                  <span class="badge border border-emerald-400/30 bg-emerald-500/20 text-emerald-100 shadow-sm">
                    <Papicon icon="check-circle" size={12} class="mr-1" />
                    {m.mcm_verif_badge_done()}
                  </span>
                {/if}
                <button
                  type="button"
                  onclick={handleRequestVerification}
                  disabled={requestVerificationBusy || verificationBlocked}
                  title={verificationPending
                    ? m.mcm_verif_already_pending()
                    : verificationBlocked
                      ? m.mcm_verif_cooldown()
                      : verifications?.lastRequestedAt
                        ? m.mcm_verif_requested_on({ date: formatVerificationDate(verifications.lastRequestedAt) })
                        : m.mcm_request_verification()}
                  class="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 disabled:bg-amber-800 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1.5 text-[10px] font-semibold text-white uppercase tracking-widest transition-all hover:scale-[1.02] active:scale-[0.98] shadow-sm cursor-pointer"
                >
                  {#if requestVerificationBusy}
                    <div class="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent"></div>
                    <span>{m.mcm_sending()}</span>
                  {:else}
                    <Papicon icon="shield-alert" size={14} />
                    <span>{m.mcm_request_verification()}</span>
                  {/if}
                </button>
                <a
                  href="/profile/{userId}"
                  class="inline-flex items-center gap-1.5 rounded-lg bg-white/15 px-3 py-1.5 text-[10px] font-semibold text-white/80 uppercase tracking-widest transition-all hover:bg-white/25 hover:text-white hover:scale-[1.02] active:scale-[0.98] shadow-sm"
                >
                  <Papicon icon="external-link" size={14} />
                  {m.mcm_profile()}
                </a>
              </div>
            {/if}
          </div>
        </div>
      </div>
    </div>

    <!-- ── Tab Navigation ────────────────────────────────────── -->
    <div class="sticky top-0 z-30 flex items-center gap-3 border-b border-outline-variant/10 bg-surface-container-lowest/95 px-6 pt-4 pb-2 backdrop-blur-sm">
      <div class="tab-group min-w-0 flex-1 overflow-x-auto">
        {#each tabs as tab}
          <button
            type="button"
            onclick={() => activeTab = tab.id}
              class="tab-button {activeTab === tab.id ? 'active' : ''}"
            >
              <Papicon icon={tab.icon} size={16} />
              <span>{tab.label}</span>
              {#if tab.count && caseData}
                {@const c = tab.count()}
                {#if c > 0}
                  <span class="flex h-5 min-w-5 items-center justify-center rounded-full text-[11px] font-semibold {activeTab === tab.id ? 'bg-white/20 text-white' : 'bg-primary/10 text-primary'}">
                    {c}
                  </span>
                {/if}
              {/if}
            </button>
          {/each}
        </div>

        <button
          type="button"
          onclick={onClose}
          aria-label={m.mcm_close_case()}
          class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-on-surface/5 text-on-surface-variant transition-colors hover:bg-on-surface/10 hover:text-on-surface"
        >
          <Papicon icon="x" size={16} />
        </button>
      </div>

      <!-- ── Content Area ──────────────────────────────────────── -->
      <div class="px-6 pb-6 pt-2">
        {#if !userId}
          <div class="flex flex-col items-center justify-center py-20 text-center bg-amber-500/5 rounded-xl border-2 border-dashed border-amber-500/20">
            <div class="flex h-16 w-16 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500 mb-6">
              <Papicon icon="alert-triangle" size={32} />
            </div>
            <h3 class="text-xl font-semibold text-amber-600 font-headline">{m.mcm_user_not_found()}</h3>
            <p class="mt-2 text-sm text-amber-700/60 max-w-sm">
              {m.mcm_user_not_found_desc()}
            </p>
          </div>
        {:else if loading}
          <div class="grid gap-6 md:grid-cols-2 lg:grid-cols-3 animate-pulse">
            <div class="h-48 bg-surface-container-high/30 rounded-xl"></div>
            <div class="h-48 bg-surface-container-high/30 rounded-xl"></div>
            <div class="h-48 bg-surface-container-high/30 rounded-xl"></div>
            <div class="md:col-span-2 h-80 bg-surface-container-high/30 rounded-xl"></div>
            <div class="h-80 bg-surface-container-high/30 rounded-xl"></div>
          </div>
        {:else if error}
          <div class="flex flex-col items-center justify-center py-20 text-center bg-rose-500/5 rounded-xl border-2 border-dashed border-rose-500/20">
            <div class="flex h-16 w-16 items-center justify-center rounded-xl bg-rose-500/10 text-rose-500 mb-6">
              <Papicon icon="alert-circle" size={32} />
            </div>
            <h3 class="text-xl font-semibold text-rose-600 font-headline">{m.mcm_load_error()}</h3>
            <p class="mt-2 text-sm text-rose-700/60 max-w-sm">{error}</p>
          </div>
        {:else if !caseData}
          <div class="flex flex-col items-center justify-center py-20 text-center bg-surface-container-low rounded-xl border-2 border-dashed border-outline-variant/30">
            <div class="flex h-16 w-16 items-center justify-center rounded-xl bg-surface-container-high text-on-surface-variant/30 mb-6">
              <Papicon icon="user-x" size={32} />
            </div>
            <h3 class="text-xl font-semibold text-on-surface-variant font-headline">{m.mcm_no_data()}</h3>
            <p class="mt-2 text-sm text-on-surface-variant/60 max-w-sm">
              {m.mcm_no_data_desc()}
            </p>
          </div>
        {:else}
          <div class="grid grid-cols-1 lg:grid-cols-4 gap-6 items-start animate-in fade-in slide-in-from-bottom-4 duration-700">
            <!-- Colonne Principale (Gauche, 3/4) -->
            <div class="lg:col-span-3 space-y-8">
            
            {#if caseData?.isSuspectedDC}
              <div class="rounded-xl bg-rose-500/10 border-2 border-rose-500/20 p-6 flex items-center gap-6 animate-in zoom-in-95 duration-500">
                <div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-rose-500/20 text-rose-500 shadow-sm">
                  <Papicon icon="alert-octagon" size={24} />
                </div>
                <div class="min-w-0 flex-1">
                  <h4 class="text-sm font-semibold text-rose-600 uppercase tracking-widest">{m.mcm_dc_title()}</h4>
                  <p class="text-xs font-bold text-rose-500/70 mt-1">
                    {m.mcm_dc_desc()}
                  </p>
                </div>
                <div class="flex gap-2">
                  <span class="badge badge-danger uppercase tracking-widest">{m.mcm_suspect()}</span>
                </div>
              </div>
            {/if}

            {#if activeTab === 'resume'}
              <!-- ── Bento Layout ────────────────── -->
              <div class="grid gap-6 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">

                <!-- Account Identity Card (Bento Large) -->
                <div class="md:col-span-2 rounded-xl bg-surface-container-low/50 p-8 border border-outline-variant/10 shadow-sm transition-all hover:shadow-xl hover:bg-surface-container-low duration-500 group">
                   <div class="flex items-center justify-between mb-8">
                     <div class="flex items-center gap-3">
                       <div class="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary group-hover:scale-110 transition-transform">
                         <Papicon icon="user" size={24} />
                       </div>
                       <div>
                         <p class="text-[10px] font-semibold uppercase tracking-wider text-primary">{m.mcm_account_info()}</p>
                         <p class="text-lg font-semibold text-on-surface">{m.mcm_identity_seniority()}</p>
                       </div>
                     </div>
                   </div>

                   <div class="grid grid-cols-2 gap-8">
                     <div class="space-y-1">
                       <p class="text-xs font-medium text-on-surface-variant/40">{m.mcm_account_age()}</p>
                       <p class="text-lg font-semibold text-on-surface">{getDurationSince(caseData?.profile?.accountCreatedAt)}</p>
                       <p class="text-[10px] font-bold text-on-surface-variant/60">{m.mcm_created_on({ date: formatDateShort(caseData?.profile?.accountCreatedAt) })}</p>
                     </div>
                     <div class="space-y-1">
                       <p class="text-xs font-medium text-on-surface-variant/40">{m.mcm_server_presence()}</p>
                       <p class="text-lg font-semibold text-on-surface">{getDurationSince(caseData?.profile?.guildJoinedAt)}</p>
                       <p class="text-[10px] font-bold text-on-surface-variant/60">{m.mcm_joined_on({ date: formatDateShort(caseData?.profile?.guildJoinedAt) })}</p>
                     </div>
                     <div class="space-y-1">
                       <p class="text-xs font-medium text-on-surface-variant/40">{m.mcm_invited_by()}</p>
                        {#if caseData?.invite?.inviterTag}
                          {#if caseData?.invite?.inviterId}
                            <button
                              type="button"
                              onclick={() => caseData?.invite?.inviterId && onSelectUser(caseData.invite.inviterId)}
                              class="flex items-center gap-2 text-left hover:text-primary transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-primary/20 rounded-xl p-1 -ml-1 group/inviter w-full"
                              title={m.mcm_open_inviter()}
                            >
                              {#if caseData.invite.inviterAvatarUrl}
                                <img
                                  src={caseData.invite.inviterAvatarUrl}
                                  alt={caseData.invite.inviterTag}
                                  class="h-6 w-6 rounded-full object-cover border border-primary/10 group-hover/inviter:border-primary transition-all duration-300"
                                />
                              {:else}
                                <div class="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center text-[10px] font-bold text-primary group-hover/inviter:bg-primary group-hover/inviter:text-on-primary transition-all duration-300">
                                  {caseData.invite.inviterTag.slice(0, 1).toUpperCase()}
                                </div>
                              {/if}
                              <p class="text-sm font-semibold text-on-surface group-hover/inviter:text-primary truncate transition-colors">@{caseData.invite.inviterTag}</p>
                            </button>
                          {:else}
                            <div class="flex items-center gap-2">
                              {#if caseData.invite.inviterAvatarUrl}
                                <img
                                  src={caseData.invite.inviterAvatarUrl}
                                  alt={caseData.invite.inviterTag}
                                  class="h-6 w-6 rounded-full object-cover border border-primary/10"
                                />
                              {:else}
                                <div class="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center text-[10px] font-bold text-primary">
                                  {caseData.invite.inviterTag.slice(0, 1).toUpperCase()}
                                </div>
                              {/if}
                              <p class="text-sm font-semibold text-on-surface truncate">@{caseData.invite.inviterTag}</p>
                            </div>
                          {/if}
                        {:else}
                          <p class="text-sm font-bold text-on-surface-variant/40 italic">{m.mcm_unknown_origin()}</p>
                        {/if}
                     </div>
                     <div class="space-y-1">
                       <p class="text-xs font-medium text-on-surface-variant/40">{m.mcm_invite_code()}</p>
                       {#if caseData?.invite?.code}
                         <button
                           type="button"
                           class="text-sm font-semibold text-primary bg-primary/10 px-3 py-1 rounded-xl hover:bg-primary/20 transition-colors"
                           onclick={() => inviteDetailsModal.show(caseData.invite.code)}
                           title={m.mcm_open_invites_view()}
                         >
                           {caseData.invite.code}
                         </button>
                       {:else}
                         <p class="text-sm font-semibold text-on-surface">-</p>
                       {/if}
                     </div>
                   </div>
                </div>

                <!-- Sanctions Status Card -->
                <div class="rounded-xl {sanctions.filter(s => s.status === 'ACTIVE').length > 0 ? 'bg-rose-500/5 border-rose-500/20 shadow-rose-500/5' : 'bg-surface-container-low/50 border-outline-variant/10 shadow-sm'} p-8 border transition-all hover:shadow-xl duration-500 group">
                   <div class="flex items-center gap-3 mb-8">
                     <div class="flex h-12 w-12 items-center justify-center rounded-lg {sanctions.filter(s => s.status === 'ACTIVE').length > 0 ? 'bg-rose-500/10 text-rose-500' : 'bg-amber-500/10 text-amber-500'} group-hover:rotate-12 transition-transform">
                       <Papicon icon="hammer" size={24} />
                     </div>
                     <div>
                       <p class="text-[10px] font-semibold uppercase tracking-wider {sanctions.filter(s => s.status === 'ACTIVE').length > 0 ? 'text-rose-500' : 'text-amber-500'}">{m.mcm_record()}</p>
                       <p class="text-lg font-semibold text-on-surface">{m.mcm_sanctions()}</p>
                     </div>
                   </div>

                   <div class="space-y-4">
                     <div class="flex items-end justify-between">
                        <span class="text-4xl font-semibold text-on-surface">{sanctions.length}</span>
                        <span class="text-xs font-medium text-on-surface-variant/40 pb-1">{m.mcm_total()}</span>
                     </div>
                     <div class="h-2 w-full rounded-full bg-on-surface/5 overflow-hidden">
                        <div class="h-full bg-rose-500 transition-all duration-1000" style="width: {sanctions.length > 0 ? (sanctions.filter(s => s.status === 'ACTIVE').length / sanctions.length) * 100 : 0}%"></div>
                     </div>
                     <p class="text-xs font-bold {sanctions.filter(s => s.status === 'ACTIVE').length > 0 ? 'text-rose-500' : 'text-on-surface-variant/60'}">
                        {m.mcm_active_sanctions({ count: sanctions.filter(s => s.status === 'ACTIVE').length })}
                     </p>
                   </div>
                </div>

                <!-- Activity Summary Card -->
                <div class="rounded-xl bg-surface-container-low/50 p-8 border border-outline-variant/10 shadow-sm transition-all hover:shadow-xl duration-500 group">
                   <div class="flex items-center gap-3 mb-8">
                     <div class="flex h-12 w-12 items-center justify-center rounded-lg bg-secondary/10 text-secondary group-hover:scale-110 transition-transform">
                       <Papicon icon="activity" size={24} />
                     </div>
                     <div>
                       <p class="text-[10px] font-semibold uppercase tracking-wider text-secondary">{m.mcm_activity()}</p>
                       <p class="text-lg font-semibold text-on-surface">{m.mcm_engagement()}</p>
                     </div>
                   </div>

                   <div class="grid grid-cols-1 gap-4">
                     <div class="flex items-center justify-between">
                       <span class="text-xs font-bold text-on-surface-variant/60">{m.mcm_messages()}</span>
                       <span class="text-sm font-semibold text-on-surface">{caseData?.profile?.messageCount?.toLocaleString(dateLocale()) ?? 0}</span>
                     </div>
                     <div class="flex items-center justify-between">
                       <span class="text-xs font-bold text-on-surface-variant/60">{m.mcm_voice()}</span>
                       <span class="text-sm font-semibold text-on-surface">{formatDurationFromSeconds(caseData?.profile?.voiceTimeSeconds)}</span>
                     </div>
                     <div class="flex items-center justify-between">
                       <span class="text-xs font-bold text-on-surface-variant/60">{m.mcm_last_pass()}</span>
                       <span class="text-sm font-semibold text-on-surface">{formatRelative(caseData?.profile?.lastSeenAt)}</span>
                     </div>
                   </div>
                </div>

                <!-- Activity Chart (Bento Large) -->
                {#if analyticsData && analyticsData.dailyTrend && analyticsData.dailyTrend.length > 0}
                  <div class="md:col-span-3 rounded-xl bg-surface-container-low/30 p-10 border border-outline-variant/10 shadow-sm group">
                    <div class="flex items-center justify-between mb-8">
                       <div class="flex items-center gap-4">
                         <div class="flex h-14 w-14 items-center justify-center rounded-lg bg-primary/10 text-primary">
                           <Papicon icon="trending-up" size={28} />
                         </div>
                         <div>
                           <p class="text-[10px] font-semibold uppercase tracking-wider text-primary">{m.mcm_statistics()}</p>
                           <h4 class="text-2xl font-semibold text-on-surface font-headline">{m.mcm_activity_trend()}</h4>
                         </div>
                       </div>
                       <div class="flex gap-2">
                         <div class="flex flex-col items-end">
                           <p class="text-2xl font-semibold text-primary">{analyticsData.totalMessages.toLocaleString('fr-FR')}</p>
                           <p class="text-xs font-medium text-on-surface-variant/40">{m.mcm_total_messages()}</p>
                         </div>
                         <div class="h-8 w-px bg-outline-variant/20 mx-4"></div>
                         <div class="flex flex-col items-end">
                           <p class="text-2xl font-semibold text-secondary">{Math.round(analyticsData.totalVoiceMinutes)}m</p>
                           <p class="text-xs font-medium text-on-surface-variant/40">{m.mcm_voice_time()}</p>
                         </div>
                       </div>
                    </div>
                    <div class="h-[200px] w-full">
                       <Chart 
                         data={{
                           labels: analyticsData.dailyTrend.map(d => d.dateKey.slice(5)),
                           datasets: [
                             {
                               label: m.mcm_messages(),
                               data: analyticsData.dailyTrend.map(d => d.messages),
                               borderColor: '#6366f1',
                               backgroundColor: 'rgba(99, 102, 241, 0.1)',
                               fill: true,
                               tension: 0.4,
                               pointRadius: 0,
                               gradient: {
                                 backgroundColor: {
                                   axis: 'y',
                                   colors: { 0: 'rgba(99, 102, 241, 0)', 100: 'rgba(99, 102, 241, 0.2)' }
                                 }
                               }
                             },
                             {
                               label: m.mcm_voice_min_series(),
                               data: analyticsData.dailyTrend.map(d => d.voiceMinutes || 0),
                               borderColor: '#ec4899',
                               backgroundColor: 'rgba(236, 72, 153, 0.1)',
                               fill: true,
                               tension: 0.4,
                               pointRadius: 0,
                               gradient: {
                                 backgroundColor: {
                                   axis: 'y',
                                   colors: { 0: 'rgba(236, 72, 153, 0)', 100: 'rgba(236, 72, 153, 0.2)' }
                                 }
                               }
                             }
                           ]
                         }} 
                         height={200} 
                       />
                     </div>
                  </div>
                {:else if analyticsLoading}
                  <div class="md:col-span-3 rounded-xl bg-surface-container-low/30 p-10 border border-outline-variant/10 shadow-sm animate-pulse flex flex-col justify-center items-center">
                    <Papicon icon="loader" size={32} class="animate-spin text-primary/20 mb-4" />
                    <p class="text-[13px] font-medium text-on-surface-variant/20">{m.mcm_computing_stats()}</p>
                  </div>
                {:else}
                  <div class="md:col-span-3 rounded-xl bg-surface-container-low/10 p-10 border border-dashed border-outline-variant/20 flex flex-col justify-center items-center text-center">
                    <div class="h-12 w-12 rounded-lg bg-on-surface/5 flex items-center justify-center text-on-surface-variant/20 mb-4">
                      <Papicon icon="bar-chart-2" size={24} />
                    </div>
                    <p class="text-sm font-semibold text-on-surface-variant/40">{m.mcm_stats_unavailable()}</p>
                    <p class="text-[10px] font-bold text-on-surface-variant/20 mt-1 uppercase tracking-widest">{m.mcm_low_activity()}</p>
                  </div>
                {/if}

                <!-- Role & Permissions (Bento Side) -->
                <div class="rounded-xl bg-surface-container-low/50 p-8 border border-outline-variant/10 shadow-sm transition-all hover:shadow-xl duration-500 group overflow-hidden relative">
                   <div class="absolute -right-10 -bottom-10 opacity-[0.03] rotate-12 pointer-events-none">
                     <Papicon icon="shield" size={160} />
                   </div>
                   <div class="flex items-center gap-3 mb-8">
                     <div class="flex h-12 w-12 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500 group-hover:scale-110 transition-transform">
                       <Papicon icon="shield" size={24} />
                     </div>
                     <div>
                       <p class="text-[10px] font-semibold uppercase tracking-wider text-emerald-500">{m.mcm_permissions()}</p>
                       <p class="text-lg font-semibold text-on-surface">{m.mcm_roles_access()}</p>
                     </div>
                   </div>

                   <div class="space-y-6">
                     <div>
                        <p class="text-[11px] font-semibold uppercase tracking-widest text-on-surface-variant/40 mb-3">{m.mcm_main_roles()}</p>
                        <div class="flex flex-wrap gap-2">
                          {#each caseData?.roles.slice(0, 4) as role}
                            <span class="px-3 py-1.5 rounded-xl bg-surface-container-high text-[10px] font-bold text-on-surface border border-outline-variant/20 flex items-center gap-1.5">
                              {#if role.color && role.color !== '#000000'}
                                <span class="w-1.5 h-1.5 rounded-full shrink-0" style="background-color: {role.color}"></span>
                              {/if}
                              {role.name}
                            </span>
                          {/each}
                          {#if caseData?.roles.length > 4}
                            <span class="px-3 py-1.5 rounded-xl bg-primary/5 text-[10px] font-semibold text-primary border border-primary/10">+{caseData?.roles.length - 4}</span>
                          {/if}
                        </div>
                     </div>
                     <div>
                        <p class="text-[11px] font-semibold uppercase tracking-widest text-on-surface-variant/40 mb-3">{m.mcm_key_permissions()}</p>
                        <div class="flex flex-wrap gap-1.5">
                          {#each caseData?.effectivePermissions.slice(0, 3) as perm}
                            <span class="text-[10px] font-semibold text-emerald-500 uppercase tracking-tighter flex items-center gap-1.5">
                              <Papicon icon="check-circle" size={10} /> {perm}
                            </span>
                          {/each}
                        </div>
                     </div>
                   </div>
                </div>

                <!-- Recent Activity Feed (Wide Footer) -->
                <div class="md:col-span-4 rounded-xl bg-surface-container-low/20 p-10 border border-outline-variant/10 group">
                  <div class="flex items-center justify-between mb-10">
                    <div class="flex items-center gap-4">
                       <div class="flex h-14 w-14 items-center justify-center rounded-lg bg-on-surface/5 text-on-surface-variant">
                         <Papicon icon="history" size={28} />
                       </div>
                       <div>
                         <p class="text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant/40">{m.mcm_timeline()}</p>
                         <h4 class="text-2xl font-semibold text-on-surface font-headline">{m.mcm_recent_activities()}</h4>
                       </div>
                    </div>
                    <button onclick={() => activeTab = 'logs'} class="group/btn inline-flex items-center gap-2 rounded-lg bg-white/5 px-6 py-3 text-xs font-semibold text-on-surface-variant uppercase tracking-widest transition-all hover:bg-white/10 hover:text-on-surface">
                      {m.mcm_see_all_logs()}
                      <Papicon icon="arrow-right" size={14} class="group-hover/btn:translate-x-1 transition-transform" />
                    </button>
                  </div>

                  <div class="grid gap-6 md:grid-cols-2">
                    <div class="space-y-4">
                       <p class="text-[10px] font-semibold uppercase tracking-wider text-primary px-2 mb-4">{m.mcm_last_messages()}</p>
                       {#each caseData?.messagesByChannel.slice(0, 3).flatMap(c => c.recentMessages.slice(0, 1)) as msg}
                         <div class="rounded-xl bg-surface-container-low/60 p-5 border border-outline-variant/5 transition-all hover:border-primary/20">
                            <div class="flex items-center justify-between mb-2">
                               <span class="text-[10px] font-bold text-primary">#{msg.channelName}</span>
                               <span class="text-[10px] font-bold text-on-surface-variant/40">{formatRelative(msg.dateIso)}</span>
                            </div>
                            <p class="text-sm text-on-surface line-clamp-2 leading-relaxed italic">"{msg.content || m.mcm_empty_content()}"</p>
                         </div>
                       {/each}
                       {#if caseData?.messagesByChannel.length === 0}
                         <p class="text-xs text-on-surface-variant/40 px-2">{m.mcm_no_recent_message()}</p>
                       {/if}
                    </div>

                    <div class="space-y-4">
                       <p class="text-[10px] font-semibold uppercase tracking-wider text-secondary px-2 mb-4">{m.mcm_last_logs()}</p>
                       <div class="space-y-3 relative pl-4 border-l border-outline-variant/20 ml-2">
                         {#each caseData?.logs.slice(0, 3) as log}
                           <div class="relative pb-6">
                              <div class="absolute -left-[calc(1rem+4.5px)] top-1 h-2 w-2 rounded-full bg-secondary border border-surface"></div>
                              <p class="text-xs font-semibold text-on-surface">{log.action}</p>
                              <p class="text-[10px] font-bold text-on-surface-variant/40 mt-0.5">{log.module} · {formatRelative(log.dateIso)}</p>
                           </div>
                         {/each}
                       </div>
                    </div>
                  </div>
                </div>

                <!-- Basic Profile Card -->
                <div class="md:col-span-4 grid gap-6 md:grid-cols-2">
                  <div class="rounded-xl bg-surface-container-low/50 p-6 border border-outline-variant/10">
                    <p class="text-[10px] font-semibold uppercase tracking-wider text-primary mb-6">{m.mcm_discord_profile()}</p>
                    <dl class="space-y-4">
                      <div class="flex items-center justify-between"><dt class="text-xs font-bold text-on-surface-variant/60">{m.mcm_username()}</dt><dd class="text-sm font-semibold text-on-surface">@{caseData?.profile?.username ?? m.mcm_unknown()}</dd></div>
                      <div class="flex items-center justify-between"><dt class="text-xs font-bold text-on-surface-variant/60">{m.mcm_global_name()}</dt><dd class="text-sm font-semibold text-on-surface">{caseData?.profile?.globalName ?? m.mcm_unknown()}</dd></div>
                      <div class="flex items-center justify-between"><dt class="text-xs font-bold text-on-surface-variant/60">{m.mcm_server_display()}</dt><dd class="text-sm font-semibold text-on-surface">{caseData?.profile?.displayName ?? m.mcm_unknown()}</dd></div>
                      <div class="flex items-center justify-between"><dt class="text-xs font-bold text-on-surface-variant/60">{m.mcm_language()}</dt><dd class="text-sm font-semibold text-on-surface uppercase tracking-widest">{caseData?.profile?.locale ?? m.mcm_unknown_f()}</dd></div>
                      <div class="flex items-center justify-between"><dt class="text-xs font-bold text-on-surface-variant/60">{m.mcm_pronouns()}</dt><dd class="text-sm font-semibold text-on-surface">{caseData?.profile?.pronouns ?? m.mcm_not_specified_plural()}</dd></div>
                    </dl>
                  </div>
                  <div class="rounded-xl bg-surface-container-low/50 p-6 border border-outline-variant/10 space-y-6">
                    <p class="text-[10px] font-semibold uppercase tracking-wider text-secondary mb-6">{m.mcm_visuals()}</p>
                    {#if caseData?.profile?.avatarUrl}
                      <div class="flex items-center gap-4">
                        <img src={caseData?.profile?.avatarUrl} alt={m.mcm_avatar_alt()} class="h-16 w-16 rounded-lg object-cover shadow-lg border-2 border-surface" />
                        <span class="text-xs font-bold text-on-surface-variant/60">{m.mcm_custom_avatar()}</span>
                      </div>
                    {/if}
                    {#if caseData?.profile?.bannerUrl}
                      <img src={caseData?.profile?.bannerUrl} alt={m.mcm_banner_alt()} class="w-full h-24 rounded-lg object-cover border border-outline-variant/10 shadow-sm" />
                    {/if}
                    {#if caseData?.profile?.accentColor}
                      <div class="flex items-center gap-3">
                        <div class="h-8 w-8 rounded-lg shadow-inner" style="background-color: #{caseData?.profile?.accentColor.toString(16).padStart(6, '0')};"></div>
                        <span class="text-xs font-bold text-on-surface-variant/60">{m.mcm_accent_color({ hex: caseData?.profile?.accentColor.toString(16).padStart(6, '0') })}</span>
                      </div>
                    {/if}
                  </div>
                </div>
              </div>

            {:else if activeTab === 'identite'}
              <div class="grid gap-6 md:grid-cols-2">
                <!-- Profile details -->
                <div class="rounded-xl bg-surface-container-low/50 p-8 border border-outline-variant/10 shadow-sm hover:bg-surface-container-low transition-all duration-500 group">
                   <div class="flex items-center gap-3 mb-8">
                     <div class="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary group-hover:scale-110 transition-transform">
                       <Papicon icon="user" size={24} />
                     </div>
                     <div>
                       <p class="text-[10px] font-semibold uppercase tracking-wider text-primary">{m.mcm_account_data()}</p>
                       <p class="text-lg font-semibold text-on-surface">{m.mcm_full_profile()}</p>
                     </div>
                   </div>
                   <dl class="space-y-5">
                     <div class="flex items-center justify-between border-b border-outline-variant/5 pb-2">
                       <dt class="text-xs font-medium text-on-surface-variant/40">{m.mcm_discord_id()}</dt>
                       <dd class="text-sm font-semibold text-on-surface select-all">{caseData?.profile?.userId ?? userId}</dd>
                     </div>
                     <div class="flex items-center justify-between border-b border-outline-variant/5 pb-2">
                       <dt class="text-xs font-medium text-on-surface-variant/40">{m.mcm_username()}</dt>
                       <dd class="text-sm font-semibold text-on-surface">@{caseData?.profile?.username ?? m.mcm_unknown()}</dd>
                     </div>
                     <div class="flex items-center justify-between border-b border-outline-variant/5 pb-2">
                       <dt class="text-xs font-medium text-on-surface-variant/40">{m.mcm_global_name_cap()}</dt>
                       <dd class="text-sm font-semibold text-on-surface">{caseData?.profile?.globalName ?? m.mcm_unknown()}</dd>
                     </div>
                     <div class="flex items-center justify-between border-b border-outline-variant/5 pb-2">
                       <dt class="text-xs font-medium text-on-surface-variant/40">{m.mcm_server_nickname()}</dt>
                       <dd class="text-sm font-semibold text-on-surface">{caseData?.profile?.displayName ?? m.mcm_unknown()}</dd>
                     </div>
                     <div class="flex items-center justify-between border-b border-outline-variant/5 pb-2">
                       <dt class="text-xs font-medium text-on-surface-variant/40">{m.mcm_pronouns()}</dt>
                       <dd class="text-sm font-semibold text-on-surface">{caseData?.profile?.pronouns ?? m.mcm_not_specified_plural()}</dd>
                     </div>
                     <div class="flex items-center justify-between">
                       <dt class="text-xs font-medium text-on-surface-variant/40">{m.mcm_language_locale()}</dt>
                       <dd class="text-sm font-semibold text-on-surface uppercase tracking-widest">{caseData?.profile?.locale ?? m.mcm_unknown_f()}</dd>
                     </div>
                   </dl>
                </div>

                <!-- Vérifications de sécurité : trace partagée entre modérateurs
                     pour ne pas redemander ce qu'un collègue a déjà lancé. -->
                <div class="rounded-xl bg-surface-container-low/50 p-8 border border-outline-variant/10 shadow-sm">
                  <div class="flex items-center gap-3 mb-8">
                    <div class="flex h-12 w-12 items-center justify-center rounded-lg bg-secondary/10 text-secondary">
                      <Papicon icon="shield-alert" size={24} />
                    </div>
                    <div class="min-w-0">
                      <p class="text-[10px] font-semibold uppercase tracking-wider text-secondary">{m.mcm_verif_history_title()}</p>
                      <p class="text-lg font-semibold text-on-surface">{m.mcm_verif_history_count({ count: verificationCount })}</p>
                    </div>
                  </div>

                  {#if verificationEntries.length === 0}
                    <p class="text-sm text-on-surface-variant/50">{m.mcm_verif_history_empty()}</p>
                  {:else}
                    <dl class="space-y-4 mb-6">
                      <div class="flex items-center justify-between border-b border-outline-variant/5 pb-2">
                        <dt class="text-xs font-medium text-on-surface-variant/40">{m.mcm_verif_last_request()}</dt>
                        <dd class="text-sm font-semibold text-on-surface">{formatVerificationDate(verifications?.lastRequestedAt)}</dd>
                      </div>
                      <div class="flex items-center justify-between border-b border-outline-variant/5 pb-2">
                        <dt class="text-xs font-medium text-on-surface-variant/40">{m.mcm_verif_last_verified()}</dt>
                        <dd class="text-sm font-semibold text-on-surface">{formatVerificationDate(verifications?.lastVerifiedAt)}</dd>
                      </div>
                    </dl>

                    <ul class="space-y-3">
                      {#each verificationEntries as entry (entry.id)}
                        <li class="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-container-high/20 px-4 py-3">
                          <div class="min-w-0">
                            <p class="text-xs font-semibold text-on-surface">
                              {m.mcm_verif_requested_on({ date: formatVerificationDate(entry.requestedAt) })}
                            </p>
                            {#if entry.verifiedAt}
                              <p class="text-[10px] font-medium text-on-surface-variant/50 mt-0.5">
                                {m.mcm_verif_verified_on({ date: formatVerificationDate(entry.verifiedAt) })}
                              </p>
                            {/if}
                          </div>
                          <span class="shrink-0 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest {VERIFICATION_STATUS_STYLES[entry.status] ?? VERIFICATION_STATUS_STYLES.EXPIRED}">
                            {verificationStatusLabel(entry.status)}
                          </span>
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </div>

                {#if caseData?.profile?.staffGrade}
                  <!-- Staff Role Section -->
                  <div class="rounded-xl bg-amber-500/5 dark:bg-amber-500/10 p-8 border border-amber-500/20 dark:border-amber-400/20 shadow-sm hover:bg-amber-500/10 dark:hover:bg-amber-500/15 transition-all duration-500 group">
                     <div class="flex items-center gap-3 mb-8">
                       <div class="flex h-12 w-12 items-center justify-center rounded-lg bg-amber-500 text-white group-hover:scale-110 transition-transform shadow-sm">
                         <Papicon icon="star" size={24} />
                       </div>
                       <div>
                         <p class="text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">{m.mcm_administration()}</p>
                         <p class="text-lg font-semibold text-on-surface">{m.mcm_staff_status()}</p>
                       </div>
                     </div>
                     <dl class="space-y-5">
                       <div class="flex items-center justify-between border-b border-amber-500/15 pb-2">
                         <dt class="text-xs font-medium text-on-surface-variant/40">{m.mcm_current_grade()}</dt>
                         <dd class="text-sm font-semibold text-amber-600 dark:text-amber-400">{caseData?.profile?.staffGrade}</dd>
                       </div>
                       <div class="flex items-center justify-between">
                         <dt class="text-xs font-medium text-on-surface-variant/40">{m.mcm_tutor_status()}</dt>
                         <dd class="text-sm font-semibold text-on-surface">
                           {caseData?.profile?.isTutor ? m.mcm_tutor_yes() : m.mcm_tutor_no()}
                         </dd>
                       </div>
                     </dl>
                  </div>
                {/if}

                <!-- Timeline -->
                <div class="rounded-xl bg-surface-container-low/50 p-8 border border-outline-variant/10 shadow-sm hover:bg-surface-container-low transition-all duration-500 group">
                   <div class="flex items-center gap-3 mb-8">
                     <div class="flex h-12 w-12 items-center justify-center rounded-lg bg-secondary/10 text-secondary group-hover:scale-110 transition-transform">
                       <Papicon icon="calendar" size={24} />
                     </div>
                     <div>
                       <p class="text-[10px] font-semibold uppercase tracking-wider text-secondary">{m.mcm_chronology()}</p>
                       <p class="text-lg font-semibold text-on-surface">{m.mcm_key_dates()}</p>
                     </div>
                   </div>
                   <dl class="space-y-5">
                     <div class="flex items-center justify-between border-b border-outline-variant/5 pb-2">
                       <dt class="text-xs font-medium text-on-surface-variant/40">{m.mcm_account_creation()}</dt>
                       <dd class="text-sm font-semibold text-on-surface">{formatDateTime(caseData?.profile?.accountCreatedAt)}</dd>
                     </div>
                     <div class="flex items-center justify-between border-b border-outline-variant/5 pb-2">
                       <dt class="text-xs font-medium text-on-surface-variant/40">{m.mcm_server_join()}</dt>
                       <dd class="text-sm font-semibold text-on-surface">{formatDateTime(caseData?.profile?.guildJoinedAt)}</dd>
                     </div>
                     {#if caseData?.profile?.guildLeftAt}
                       <div class="flex items-center justify-between border-b border-outline-variant/5 pb-2">
                         <dt class="text-xs font-medium text-rose-500/60">{m.mcm_last_leave()}</dt>
                         <dd class="text-sm font-semibold text-rose-500">{formatDateTime(caseData?.profile?.guildLeftAt)}</dd>
                       </div>
                     {/if}
                     <div class="flex items-center justify-between border-b border-outline-variant/5 pb-2">
                       <dt class="text-xs font-medium text-on-surface-variant/40">{m.mcm_first_seen()}</dt>
                       <dd class="text-sm font-semibold text-on-surface">{formatDateTime(caseData?.profile?.firstSeenAt)}</dd>
                     </div>
                     <div class="flex items-center justify-between">
                       <dt class="text-xs font-medium text-on-surface-variant/40">{m.mcm_last_seen()}</dt>
                       <dd class="text-sm font-semibold text-on-surface">{formatDateTime(caseData?.profile?.lastSeenAt)}</dd>
                     </div>
                   </dl>
                </div>

                <!-- Roles Detailed -->
                <div class="md:col-span-2 rounded-xl bg-surface-container-low/50 p-8 border border-outline-variant/10 shadow-sm hover:bg-surface-container-low transition-all duration-500 group">
                   <div class="flex items-center gap-3 mb-8">
                     <div class="flex h-12 w-12 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500 group-hover:rotate-12 transition-transform">
                       <Papicon icon="shield" size={24} />
                     </div>
                     <div>
                       <p class="text-[10px] font-semibold uppercase tracking-wider text-emerald-500">{m.mcm_permissions()}</p>
                       <p class="text-lg font-semibold text-on-surface">{m.mcm_roles_count({ count: caseData?.roles.length })}</p>
                     </div>
                   </div>
                   <div class="flex flex-wrap gap-3">
                     {#each caseData?.roles as role}
                       <span class="px-5 py-2.5 rounded-lg bg-surface-container-high text-xs font-semibold text-on-surface border border-outline-variant/20 shadow-sm transition-all hover:bg-surface-container-highest flex items-center gap-2">
                         {#if role.color && role.color !== '#000000'}
                           <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background-color: {role.color}"></span>
                         {/if}
                         {role.name}
                       </span>
                     {/each}
                     {#if caseData?.roles.length === 0}
                        <div class="w-full py-10 text-center bg-surface-container-low rounded-xl border border-dashed border-outline-variant/20">
                          <p class="text-sm font-semibold text-on-surface-variant/40 uppercase tracking-widest">{m.mcm_no_role()}</p>
                        </div>
                     {/if}
                   </div>
                </div>
              </div>

            {:else if activeTab === 'activite'}
                <div class="space-y-8">
                  <div class="grid gap-6 md:grid-cols-3">
                    <div class="rounded-xl bg-primary/5 p-6 border border-primary/10 text-center">
                      <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary mx-auto mb-4">
                        <Papicon icon="message-square" size={20} />
                      </div>
                      <p class="text-2xl font-semibold text-on-surface">{caseData?.profile?.messageCount ?? 0}</p>
                      <p class="text-[11px] font-semibold uppercase tracking-widest text-primary/60 mt-1">{m.mcm_messages()}</p>
                    </div>
                    <div class="rounded-xl bg-secondary/5 p-6 border border-secondary/10 text-center">
                      <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-secondary/10 text-secondary mx-auto mb-4">
                        <Papicon icon="mic" size={20} />
                      </div>
                      <p class="text-2xl font-semibold text-on-surface">{formatDurationFromSeconds(caseData?.profile?.voiceTimeSeconds)}</p>
                      <p class="text-[11px] font-semibold uppercase tracking-widest text-secondary/60 mt-1">{m.mcm_voice_time()}</p>
                    </div>
                    <div class="rounded-xl bg-emerald-500/5 p-6 border border-emerald-500/10 text-center">
                      <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-500 mx-auto mb-4">
                        <Papicon icon="eye" size={20} />
                      </div>
                      <p class="text-lg font-semibold text-on-surface">{formatDateShort(caseData?.profile?.lastSeenAt)}</p>
                      <p class="text-[11px] font-semibold uppercase tracking-widest text-emerald-500/60 mt-1">{m.mcm_last_activity()}</p>
                    </div>
                  </div>

                  <div class="rounded-xl bg-surface-container-low/50 p-8 border border-outline-variant/10">
                    <p class="text-[10px] font-semibold uppercase tracking-wider text-primary mb-8 px-2">{m.mcm_by_channel()}</p>
                    <div class="space-y-6">
                      {#each caseData?.messagesByChannel || [] as channel}
                        {@const max = Math.max(...(caseData?.messagesByChannel || []).map(c => c.count), 1)}
                        <div class="space-y-2">
                          <div class="flex items-center justify-between px-1">
                            <span class="text-sm font-semibold text-on-surface">{channel.channelName}</span>
                            <span class="text-xs font-bold text-on-surface-variant/60">{channel.count} messages</span>
                          </div>
                          <div class="h-2 w-full rounded-full bg-surface-container-high overflow-hidden">
                            <div class="h-full bg-linear-to-r from-primary to-secondary transition-all duration-1000" style="width: {(channel.count / max) * 100}%"></div>
                          </div>
                        </div>
                      {/each}
                    </div>
                  </div>
                </div>

              {:else if activeTab === 'analytics'}
                <div class="space-y-8">
                  {#if analyticsLoading}
                    <div class="flex flex-col items-center justify-center py-24 bg-surface-container-low/30 rounded-xl border border-outline-variant/10">
                      <div class="relative mb-6">
                        <div class="absolute -inset-4 rounded-full bg-primary/10 blur-xl animate-pulse"></div>
                        <Papicon icon="loader" size={48} class="animate-spin text-primary" />
                      </div>
                      <p class="text-[13px] font-medium text-on-surface-variant/60">{m.mcm_analyzing_behavior()}</p>
                    </div>
                  {:else if analyticsData && analyticsData.dailyTrend && analyticsData.dailyTrend.length > 0}
                    <div class="grid gap-6 lg:grid-cols-2">
                       <div class="rounded-xl bg-surface-container-low/50 p-8 border border-outline-variant/10 shadow-sm group">
                         <div class="flex items-center justify-between mb-8">
                            <div>
                              <p class="text-xs font-medium text-primary mb-1">{m.mcm_activity()}</p>
                              <h4 class="text-sm font-semibold text-on-surface uppercase tracking-widest">{m.mcm_message_volume()}</h4>
                            </div>
                            <span class="text-[10px] font-bold text-on-surface-variant/40 bg-surface-container-high px-3 py-1 rounded-lg">{m.mcm_last_30_days()}</span>
                         </div>
                          <Chart 
                            data={{
                              labels: analyticsData.dailyTrend.map(d => d.dateKey.slice(5)),
                              datasets: [{
                                label: m.mcm_messages(),
                                data: analyticsData.dailyTrend.map(d => d.messages),
                                borderColor: '#6366f1',
                                backgroundColor: 'rgba(99, 102, 241, 0.1)',
                                fill: true,
                                tension: 0.4,
                                pointRadius: 0,
                                gradient: {
                                  backgroundColor: {
                                    axis: 'y',
                                    colors: { 0: 'rgba(99, 102, 241, 0)', 100: 'rgba(99, 102, 241, 0.2)' }
                                  }
                                }
                              }]
                            }} 
                            height={180} 
                          />
                       </div>
                       <div class="rounded-xl bg-surface-container-low/50 p-8 border border-outline-variant/10 shadow-sm group">
                         <div class="flex items-center justify-between mb-8">
                            <div>
                              <p class="text-xs font-medium text-secondary mb-1">{m.mcm_engagement()}</p>
                              <h4 class="text-sm font-semibold text-on-surface uppercase tracking-widest">{m.mcm_voice_activity()}</h4>
                            </div>
                            <span class="text-[10px] font-bold text-on-surface-variant/40 bg-surface-container-high px-3 py-1 rounded-lg">{m.mcm_minutes_per_day()}</span>
                         </div>
                          <Chart 
                            data={{
                              labels: analyticsData.dailyTrend.map(d => d.dateKey.slice(5)),
                              datasets: [{
                                label: m.mcm_voice_min_series(),
                                data: analyticsData.dailyTrend.map(d => d.voiceMinutes),
                                borderColor: '#ec4899',
                                backgroundColor: 'rgba(236, 72, 153, 0.1)',
                                fill: true,
                                tension: 0.4,
                                pointRadius: 0,
                                gradient: {
                                  backgroundColor: {
                                    axis: 'y',
                                    colors: { 0: 'rgba(236, 72, 153, 0)', 100: 'rgba(236, 72, 153, 0.2)' }
                                  }
                                }
                              }]
                            }} 
                            height={180} 
                          />
                       </div>
                    </div>
                  {:else}
                    <div class="flex flex-col items-center justify-center py-24 text-center bg-surface-container-low/30 rounded-xl border-2 border-dashed border-outline-variant/20">
                      <div class="flex h-20 w-20 items-center justify-center rounded-xl bg-surface-container-high text-on-surface-variant/20 mb-8">
                        <Papicon icon="bar-chart-2" size={40} />
                      </div>
                      <h3 class="text-2xl font-semibold text-on-surface-variant font-headline">{m.mcm_no_analytics()}</h3>
                      <p class="mt-2 text-sm text-on-surface-variant/60 max-w-sm mx-auto px-6">
                        {m.mcm_no_analytics_desc()}
                      </p>
                    </div>
                  {/if}
                </div>

              {:else if activeTab === 'messages'}
                <div class="space-y-6">
                  <!-- Barre de Filtres Ergonomique -->
                  <div class="flex flex-col gap-4 rounded-xl bg-surface-container-low/50 p-4 border border-outline-variant/10 md:flex-row md:items-center">
                    <div class="relative flex-1">
                      <span class="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-on-surface-variant/40">
                        <Papicon icon="search" size={16} />
                      </span>
                      <input
                        type="search"
                        bind:value={messageQuery}
                        oninput={() => { messageOffset = 0; }}
                        placeholder={m.mcm_search_messages()}
                        class="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 py-2 pl-10 pr-10 text-xs text-on-surface placeholder:text-on-surface-variant/30 outline-hidden transition-all focus:border-primary/30 focus:bg-surface-container-high"
                      />
                    </div>

                    <div class="flex flex-wrap items-center gap-3">
                      <!-- Select Salon -->
                      <div class="relative">
                        <select
                          bind:value={messageChannelId}
                          onchange={() => { messageOffset = 0; }}
                          class="appearance-none rounded-lg border border-outline-variant/10 bg-surface-container-high/40 py-2 pl-3 pr-8 text-xs font-bold text-on-surface-variant focus:border-primary/30 focus:outline-hidden"
                        >
                          <option value="">{m.mcm_all_channels()}</option>
                          {#each messagesChannels as channel}
                            <option value={channel.channelId}>#{channel.channelName} ({channel.count})</option>
                          {/each}
                        </select>
                        <span class="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-on-surface-variant/40">
                          <Papicon icon="chevron-down" size={12} />
                        </span>
                      </div>

                      <!-- Dates -->
                      <div class="flex items-center gap-1.5 text-xs text-on-surface-variant/60">
                        <span>{m.mcm_date_from()}</span>
                        <input
                          type="date"
                          bind:value={messageFrom}
                          onchange={() => { messageOffset = 0; }}
                          class="rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-2 py-1.5 text-xs font-bold text-on-surface outline-hidden focus:border-primary/30"
                        />
                        <span>{m.mcm_date_to()}</span>
                        <input
                          type="date"
                          bind:value={messageTo}
                          onchange={() => { messageOffset = 0; }}
                          class="rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-2 py-1.5 text-xs font-bold text-on-surface outline-hidden focus:border-primary/30"
                        />
                      </div>

                      <!-- Deleted toggle -->
                      <label class="inline-flex items-center gap-2 cursor-pointer select-none text-xs font-bold text-on-surface-variant/70">
                        <input
                          type="checkbox"
                          bind:checked={messageIncludeDeleted}
                          onchange={() => { messageOffset = 0; }}
                          class="rounded border-outline-variant/30 text-primary focus:ring-primary/20 h-4 w-4 bg-surface-container-high/40"
                        />
                        <span>{m.mcm_show_deleted()}</span>
                      </label>
                    </div>
                  </div>

                  <!-- Fil de messages -->
                  {#if messagesLoading}
                    <div class="space-y-4 animate-pulse">
                      {#each Array(4) as _}
                        <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 p-5">
                          <div class="flex justify-between items-center mb-3">
                            <div class="h-3.5 w-1/4 rounded bg-on-surface/5"></div>
                            <div class="h-3 w-20 rounded bg-on-surface/5"></div>
                          </div>
                          <div class="space-y-2">
                            <div class="h-3 w-full rounded bg-on-surface/5"></div>
                            <div class="h-3 w-5/6 rounded bg-on-surface/5"></div>
                          </div>
                        </div>
                      {/each}
                    </div>
                  {:else if messagesList.length === 0}
                    <div class="flex flex-col items-center justify-center py-20 text-center bg-surface-container-low/30 rounded-xl border-2 border-dashed border-outline-variant/20">
                      <div class="flex h-16 w-16 items-center justify-center rounded-xl bg-surface-container-high text-on-surface-variant/20 mb-6">
                        <Papicon icon="message-square" size={32} />
                      </div>
                      <h3 class="text-lg font-semibold text-on-surface font-headline">{m.mcm_no_message_found()}</h3>
                      <p class="mt-2 text-xs text-on-surface-variant/60 max-w-sm mx-auto px-6">
                        {m.mcm_no_message_found_desc()}
                      </p>
                    </div>
                  {:else}
                    <div class="space-y-4">
                      {#each messagesList as msg (msg.id)}
                        <div class="group rounded-xl border p-5 transition-all duration-300 {msg.deletedAt ? 'border-red-500/10 bg-red-500/5' : 'border-outline-variant/10 bg-surface-container-low/50 hover:bg-surface-container-low hover:border-outline-variant/25'}">
                          <div class="flex flex-wrap items-center justify-between gap-3 mb-3 pb-2.5 border-b border-outline-variant/5">
                            <div class="flex items-center gap-2.5">
                              <span class="inline-flex items-center gap-1.5 text-xs font-semibold text-primary bg-primary/10 px-2.5 py-1 rounded-lg">
                                <Papicon icon="tag" size={12} />
                                #{msg.channelName}
                              </span>
                              <span class="text-[10px] font-bold text-on-surface-variant/40">{formatDateTime(msg.createdAt)}</span>
                              
                              {#if msg.editedAt}
                                <span class="badge bg-amber-500/10 text-amber-500 text-[9px]" title={m.mcm_edited_on({ date: formatDateTime(msg.editedAt) })}>{m.mcm_edited()}</span>
                              {/if}
                              {#if msg.deletedAt}
                                <span class="badge bg-red-500/15 text-red-500 text-[9px] border border-red-500/30" title={m.mcm_deleted_on({ date: formatDateTime(msg.deletedAt) })}>{m.mcm_deleted()}</span>
                              {/if}
                            </div>
                            
                            {#if !msg.deletedAt}
                              <a
                                href="https://discord.com/channels/{authStore.selectedGuildId}/{msg.channelId}/{msg.messageId}"
                                target="_blank"
                                rel="noopener noreferrer"
                                class="inline-flex items-center gap-1 text-[10px] font-bold text-on-surface-variant/40 hover:text-primary uppercase tracking-wider transition-colors"
                              >
                                Jump
                                <Papicon icon="arrow-up-right" size={10} />
                              </a>
                            {/if}
                          </div>

                          <p class="text-sm text-on-surface leading-relaxed whitespace-pre-wrap select-text">
                            {msg.content || (msg.hasAttachment ? m.mcm_empty_with_attachments() : m.mcm_empty_content())}
                          </p>

                          <!-- Rendu riche des pièces jointes -->
                          {#if msg.attachments && Array.isArray(msg.attachments) && msg.attachments.length > 0}
                            <div class="mt-4 flex flex-wrap gap-2.5">
                              {#each msg.attachments as att}
                                {#if att.contentType?.startsWith('image/')}
                                  <a
                                    href={att.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    class="block max-w-[240px] max-h-[160px] overflow-hidden rounded-lg border border-outline-variant/15 hover:opacity-90 transition-opacity"
                                  >
                                    <img src={att.url} alt={att.name} class="w-full h-full object-cover" />
                                  </a>
                                {:else}
                                  <a
                                    href={att.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    class="inline-flex items-center gap-2 rounded-lg bg-surface-container-high/50 border border-outline-variant/10 px-3.5 py-2 text-xs font-bold text-primary hover:bg-surface-container-high transition-colors"
                                  >
                                    <Papicon icon="file" size={14} />
                                    <span class="truncate max-w-[160px]" title={att.name}>{att.name}</span>
                                  </a>
                                {/if}
                              {/each}
                            </div>
                          {/if}
                        </div>
                      {/each}
                    </div>

                    <!-- Pagination -->
                    {#if messagesTotalCount > messageLimit}
                      <div class="flex items-center justify-between border-t border-outline-variant/10 pt-6">
                        <span class="text-xs font-bold text-on-surface-variant/40">
                          {m.mcm_pagination_range({ from: messageOffset + 1, to: Math.min(messageOffset + messageLimit, messagesTotalCount), total: messagesTotalCount })}
                        </span>

                        <div class="flex items-center gap-2">
                          <button
                            type="button"
                            onclick={() => { messageOffset = Math.max(0, messageOffset - messageLimit); }}
                            disabled={messageOffset === 0}
                            class="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-container-high text-on-surface-variant hover:bg-surface-container-high-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          >
                            <Papicon icon="chevron-left" size={14} />
                          </button>

                          <button
                            type="button"
                            onclick={() => { messageOffset = messageOffset + messageLimit; }}
                            disabled={messageOffset + messageLimit >= messagesTotalCount}
                            class="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-container-high text-on-surface-variant hover:bg-surface-container-high-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          >
                            <Papicon icon="chevron-right" size={14} />
                          </button>
                        </div>
                      </div>
                    {/if}
                  {/if}
                </div>

              {:else if activeTab === 'logs'}
                <!-- Meme barre de filtres que l'onglet Messages, appliquee ici
                     cote client : les logs sont deja tous charges. -->
                <div class="mb-6 flex flex-col gap-4 rounded-xl bg-surface-container-low/50 p-4 border border-outline-variant/10 md:flex-row md:items-center">
                  <div class="relative flex-1">
                    <span class="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-on-surface-variant/40">
                      <Papicon icon="search" size={16} />
                    </span>
                    <input
                      type="search"
                      bind:value={logQuery}
                      placeholder={m.mcm_search_logs()}
                      class="w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 py-2 pl-10 pr-4 text-xs text-on-surface placeholder:text-on-surface-variant/30 outline-hidden transition-all focus:border-primary/30 focus:bg-surface-container-high"
                    />
                  </div>

                  <div class="flex flex-wrap items-center gap-3">
                    <div class="relative">
                      <select
                        bind:value={logModule}
                        class="appearance-none rounded-lg border border-outline-variant/10 bg-surface-container-high/40 py-2 pl-3 pr-8 text-xs font-bold text-on-surface-variant focus:border-primary/30 focus:outline-hidden"
                      >
                        <option value="">{m.mcm_all_modules()}</option>
                        {#each logModules as moduleName}
                          <option value={moduleName}>{moduleName}</option>
                        {/each}
                      </select>
                      <span class="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-on-surface-variant/40">
                        <Papicon icon="chevron-down" size={12} />
                      </span>
                    </div>

                    <div class="relative">
                      <select
                        bind:value={logSource}
                        class="appearance-none rounded-lg border border-outline-variant/10 bg-surface-container-high/40 py-2 pl-3 pr-8 text-xs font-bold text-on-surface-variant focus:border-primary/30 focus:outline-hidden"
                      >
                        <option value="">{m.mcm_all_sources()}</option>
                        {#each logSources as sourceName}
                          <option value={sourceName}>{sourceName}</option>
                        {/each}
                      </select>
                      <span class="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-on-surface-variant/40">
                        <Papicon icon="chevron-down" size={12} />
                      </span>
                    </div>

                    <div class="flex items-center gap-1.5 text-xs text-on-surface-variant/60">
                      <span>{m.mcm_date_from()}</span>
                      <input
                        type="date"
                        bind:value={logFrom}
                        class="rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-2 py-1.5 text-xs font-bold text-on-surface outline-hidden focus:border-primary/30"
                      />
                      <span>{m.mcm_date_to()}</span>
                      <input
                        type="date"
                        bind:value={logTo}
                        class="rounded-lg border border-outline-variant/10 bg-surface-container-high/40 px-2 py-1.5 text-xs font-bold text-on-surface outline-hidden focus:border-primary/30"
                      />
                    </div>

                    <div class="relative">
                      <select
                        bind:value={logOrder}
                        class="appearance-none rounded-lg border border-outline-variant/10 bg-surface-container-high/40 py-2 pl-3 pr-8 text-xs font-bold text-on-surface-variant focus:border-primary/30 focus:outline-hidden"
                      >
                        <option value="desc">{m.mcm_sort_newest()}</option>
                        <option value="asc">{m.mcm_sort_oldest()}</option>
                      </select>
                      <span class="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-on-surface-variant/40">
                        <Papicon icon="chevron-down" size={12} />
                      </span>
                    </div>

                    <span class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40">
                      {m.mcm_logs_shown({ shown: filteredLogs.length, total: caseData?.logs?.length ?? 0 })}
                    </span>
                  </div>
                </div>

                <div class="rounded-xl bg-surface-container-low/50 p-8 border border-outline-variant/10">
                  <div class="space-y-8 relative pl-6 border-l-2 border-outline-variant/20 ml-4">
                    {#each filteredLogs as log}
                      <div class="relative">
                        <div class="absolute -left-[calc(1.5rem+5px)] top-1.5 h-3 w-3 rounded-full bg-primary border-2 border-surface shadow-sm"></div>
                        <div class="flex items-start justify-between gap-4 mb-2">
                          <div>
                            <p class="text-sm font-semibold text-on-surface tracking-tight">{log.action}</p>
                            <p class="text-xs font-medium text-on-surface-variant/40 mt-1">{log.module} · {log.source}</p>
                          </div>
                          <span class="text-[10px] font-semibold text-on-surface-variant/30 uppercase tracking-widest">{formatDateTime(log.dateIso)}</span>
                        </div>
                        <div class="rounded-lg bg-surface-container-high/30 p-4 text-xs text-on-surface-variant/80 italic leading-relaxed">
                          {@html renderLogSnippet(log.details)}
                        </div>
                      </div>
                    {/each}
                    {#if filteredLogs.length === 0}
                      <div class="flex flex-col items-center justify-center py-10 text-on-surface-variant/20">
                         <Papicon icon="history" size={48} />
                         <p class="mt-4 text-sm font-semibold uppercase tracking-widest">
                           {(caseData?.logs?.length ?? 0) === 0 ? m.mcm_no_log() : m.mcm_no_log_match()}
                         </p>
                      </div>
                    {/if}
                  </div>
                </div>

              {:else if activeTab === 'sanctions'}
                {#if crossServer?.enabled && crossServer.total > 0}
                  <div class="mb-6 rounded-xl bg-surface-container-low/50 border border-outline-variant/10 overflow-hidden shadow-sm">
                    <!-- En-tête -->
                    <div class="flex items-center gap-4 px-6 py-5 border-b border-outline-variant/10">
                      <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-500">
                        <Papicon icon="globe" size={22} />
                      </div>
                      <div class="min-w-0 flex-1">
                        <p class="text-[10px] font-semibold uppercase tracking-wider text-amber-500">{m.mcm_cross_server_record()}</p>
                        <p class="text-sm font-semibold text-on-surface">
                          {crossServer.total > 1 ? m.mcm_cross_server_count_other({ count: crossServer.total }) : m.mcm_cross_server_count_one({ count: crossServer.total })}
                          <span class="text-on-surface-variant/50 font-medium">{crossServer.serverCount > 1 ? m.mcm_cross_server_on_other({ count: crossServer.serverCount }) : m.mcm_cross_server_on_one({ count: crossServer.serverCount })}</span>
                        </p>
                      </div>
                      <div class="hidden md:flex flex-wrap items-center justify-end gap-1.5">
                        {#each crossServerBreakdown as [type, count]}
                          {@const style = getSanctionTypeStyle(type)}
                          <span class="inline-flex items-center gap-1.5 rounded-lg bg-surface-container-high px-2.5 py-1 text-[11px] font-semibold text-on-surface-variant">
                            <span class="h-1.5 w-1.5 rounded-full {style.dot}"></span>
                            {formatTypeLabel(type)}
                            <span class="text-on-surface-variant/50">{count}</span>
                          </span>
                        {/each}
                      </div>
                    </div>

                    <!-- Liste -->
                    <ul class="divide-y divide-outline-variant/10">
                      {#each crossServer.recent as entry}
                        {@const style = getSanctionTypeStyle(entry.type)}
                        <li class="flex items-center gap-4 px-6 py-3.5 hover:bg-surface-container-high/20 transition-colors">
                          <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg {style.tile}">
                            <Papicon icon={style.icon} size={16} />
                          </div>
                          <div class="min-w-0 flex-1">
                            <div class="flex items-center gap-2">
                              <span class="text-sm font-semibold text-on-surface">{formatTypeLabel(entry.type)}</span>
                              {#if entry.durationSeconds}
                                <span class="text-[11px] font-medium text-on-surface-variant/50">· {formatDurationFromSeconds(entry.durationSeconds)}</span>
                              {/if}
                            </div>
                            {#if entry.reason?.trim()}
                              <p class="mt-0.5 text-xs text-on-surface-variant/80 truncate" title={entry.reason}>{entry.reason}</p>
                            {/if}
                            <p class="mt-0.5 flex items-center gap-1 text-[11px] font-medium text-on-surface-variant/50 truncate" title={entry.guildName}>
                              <Papicon icon="map-pin" size={11} class="shrink-0 opacity-50" />
                              <span class="truncate">{entry.guildName}</span>
                            </p>
                          </div>
                          <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-semibold uppercase tracking-widest shrink-0 {entry.status === 'ACTIVE' ? 'bg-rose-500/10 text-rose-500' : 'bg-emerald-500/10 text-emerald-500'}">
                            <span class="h-1.5 w-1.5 rounded-full {entry.status === 'ACTIVE' ? 'bg-rose-500' : 'bg-emerald-500'}"></span>
                            {getSanctionStatusLabel(entry.status)}
                          </span>
                          <span class="text-[11px] font-medium text-on-surface-variant/40 w-24 text-right shrink-0 hidden sm:block">{formatRelative(entry.createdAt)}</span>
                        </li>
                      {/each}
                    </ul>

                    <!-- Pied -->
                    <div class="flex items-center justify-between gap-3 px-6 py-3 border-t border-outline-variant/10 bg-surface-container-low/30">
                      <p class="flex items-center gap-1.5 text-[11px] font-medium text-on-surface-variant/40">
                        <Papicon icon="lock" size={12} class="shrink-0" />
                        {m.mcm_same_instance()}
                      </p>
                      {#if crossServer.total > crossServer.recent.length}
                        <span class="text-[11px] font-semibold text-on-surface-variant/50 shrink-0">{crossServer.total - crossServer.recent.length > 1 ? m.mcm_cross_server_more_other({ count: crossServer.total - crossServer.recent.length }) : m.mcm_cross_server_more_one({ count: crossServer.total - crossServer.recent.length })}</span>
                      {/if}
                    </div>
                  </div>
                {/if}
                <div class="rounded-xl bg-surface-container-low/50 overflow-hidden border border-outline-variant/10 shadow-sm">
                  <table class="w-full text-left border-collapse">
                    <thead>
                      <tr class="bg-surface-container-high/30">
                        <th class="px-6 py-4 text-xs font-medium text-on-surface-variant/40">{m.mcm_col_date()}</th>
                        <th class="px-6 py-4 text-xs font-medium text-on-surface-variant/40">{m.mcm_col_action()}</th>
                        <th class="px-6 py-4 text-xs font-medium text-on-surface-variant/40">{m.mcm_col_status()}</th>
                        <th class="px-6 py-4 text-xs font-medium text-on-surface-variant/40">{m.mcm_col_reason()}</th>
                        <th class="px-6 py-4 text-xs font-medium text-on-surface-variant/40">{m.mcm_col_report()}</th>
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-outline-variant/10">
                      {#each sanctions as sanction}
                        {@const hasReport = [...(dashboardStore.state.sanctionReports || []), ...(caseData?.sanctionReports || [])].some(r => r.sanctionId === sanction.id)}
                        <tr class="hover:bg-surface-container-high/20 transition-colors">
                          <td class="px-6 py-4 text-xs font-bold text-on-surface-variant/60">{formatDateShort(sanction.createdAt)}</td>
                          <td class="px-6 py-4">
                            <span class="text-xs font-semibold text-primary uppercase tracking-widest">{formatTypeLabel(sanction.type)}</span>
                            <p class="text-[10px] font-bold text-on-surface-variant/40 mt-0.5">{m.mcm_by_moderator({ moderator: sanction.moderatorTag })}</p>
                          </td>
                          <td class="px-6 py-4">
                            <span class="px-3 py-1 rounded-lg text-xs font-medium {sanction.status === 'ACTIVE' ? 'bg-rose-500/10 text-rose-500' : 'bg-emerald-500/10 text-emerald-500'}">
                              {getSanctionStatusLabel(sanction.status)}
                            </span>
                          </td>
                          <td class="px-6 py-4 text-xs text-on-surface-variant max-w-xs truncate">{sanction.reason}</td>
                          <td class="px-6 py-4">
                            {#if hasReport}
                              <button
                                onclick={() => viewingReportSanctionId = sanction.id}
                                class="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[10px] font-semibold text-on-primary uppercase tracking-widest transition-all hover:bg-primary-container hover:scale-[1.02] active:scale-[0.98] shadow-xs cursor-pointer"
                              >
                                <Papicon icon="file-text" size={12} />
                                {m.mcm_see_more()}
                              </button>
                            {:else}
                              <span class="text-[10px] font-bold text-on-surface-variant/30 italic">{m.mcm_no_report()}</span>
                            {/if}
                          </td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                  {#if sanctions.length === 0}
                    <div class="flex flex-col items-center py-20 text-on-surface-variant/30">
                      <Papicon icon="check-circle" size={48} />
                      <p class="mt-4 text-sm font-semibold uppercase tracking-widest">{m.mcm_clean_record()}</p>
                    </div>
                  {/if}
                </div>

              {:else if activeTab === 'invites'}
                <div class="grid gap-6 md:grid-cols-2">
                   <div class="rounded-xl bg-surface-container-low/50 p-6 border border-outline-variant/10">
                     <p class="text-[10px] font-semibold uppercase tracking-wider text-primary mb-6">{m.mcm_invite_source()}</p>
                     <dl class="space-y-4">
                       <div class="flex items-center justify-between">
                         <dt class="text-xs font-bold text-on-surface-variant/60">{m.mcm_code_used()}</dt>
                         {#if caseData?.invite?.code}
                           <button
                             type="button"
                             class="text-sm font-semibold text-primary bg-primary/10 px-3 py-1 rounded-xl hover:bg-primary/20 transition-colors font-mono"
                             onclick={() => inviteDetailsModal.show(caseData.invite.code)}
                             title={m.mcm_open_invites_view()}
                           >
                             {caseData.invite.code}
                           </button>
                         {:else}
                           <dd class="text-sm font-semibold text-on-surface font-mono">{m.mcm_unknown()}</dd>
                         {/if}
                       </div>
                       <div class="flex items-center justify-between">
                          <dt class="text-xs font-bold text-on-surface-variant/60">{m.mcm_creator()}</dt>
                          <dd class="text-sm font-semibold text-on-surface">
                            {#if caseData?.invite?.inviterTag}
                              <div class="flex items-center gap-2">
                                {#if caseData.invite.inviterAvatarUrl}
                                  <img
                                    src={caseData.invite.inviterAvatarUrl}
                                    alt={caseData.invite.inviterTag}
                                    class="h-5 w-5 rounded-full object-cover border border-primary/10"
                                  />
                                {/if}
                                {#if caseData?.invite?.inviterId}
                                  <button
                                    type="button"
                                    onclick={() => caseData?.invite?.inviterId && onSelectUser(caseData.invite.inviterId)}
                                    class="text-primary hover:underline focus:outline-none font-semibold text-left"
                                    title={m.mcm_open_inviter()}
                                  >
                                    @{caseData.invite.inviterTag}
                                  </button>
                                {:else}
                                  @{caseData.invite.inviterTag}
                                {/if}
                              </div>
                            {:else}
                              {m.mcm_unknown()}
                            {/if}
                          </dd>
                        </div>
                       <div class="flex items-center justify-between"><dt class="text-xs font-bold text-on-surface-variant/60">{m.mcm_use_date()}</dt><dd class="text-sm font-semibold text-on-surface">{formatDateTime(caseData?.invite?.joinedAt ?? caseData?.profile?.guildJoinedAt)}</dd></div>
                     </dl>
                   </div>
                   <div class="rounded-xl bg-surface-container-low/50 p-6 border border-outline-variant/10">
                     <p class="text-[10px] font-semibold uppercase tracking-wider text-secondary mb-6">{m.mcm_server_moves()}</p>
                     <dl class="space-y-4">
                       <div class="flex items-center justify-between"><dt class="text-xs font-bold text-on-surface-variant/60">{m.mcm_last_join()}</dt><dd class="text-sm font-semibold text-on-surface">{formatDateTime(caseData?.profile?.guildJoinedAt)}</dd></div>
                       <div class="flex items-center justify-between"><dt class="text-xs font-bold text-on-surface-variant/60">{m.mcm_last_leave_row()}</dt><dd class="text-sm font-semibold text-on-surface">{formatDateTime(caseData?.profile?.guildLeftAt)}</dd></div>
                       <div class="flex items-center justify-between"><dt class="text-xs font-bold text-on-surface-variant/60">{m.mcm_first_observation()}</dt><dd class="text-sm font-semibold text-on-surface">{formatDateTime(caseData?.profile?.firstSeenAt)}</dd></div>
                     </dl>
                   </div>
                </div>

              {:else if activeTab === 'connexions'}
                <div class="space-y-6">
                  <div class="flex items-center justify-between px-2">
                    <div>
                      <p class="text-[10px] font-semibold uppercase tracking-wider text-primary mb-1">{m.mcm_social_network()}</p>
                      <h4 class="text-sm font-semibold text-on-surface uppercase tracking-widest">{m.mcm_interaction_graph()}</h4>
                    </div>
                    <div class="flex items-center gap-2">
                      <span class="text-[10px] font-bold text-on-surface-variant/40 bg-surface-container-high px-3 py-1 rounded-lg">{m.mcm_top_contacts({ count: (caseData?.interactionGraph?.nodes?.length ?? 1) - 1 })}</span>
                    </div>
                  </div>
                  
                  <div class="w-full h-[520px]">
                    <InteractionTree 
                      nodes={caseData?.interactionGraph?.nodes || []} 
                      edges={caseData?.interactionGraph?.edges || []} 
                      onSelectNode={onSelectUser}
                    />
                  </div>

                  <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {#each caseData?.connections as connection}
                      <div class="flex items-center gap-4 rounded-xl bg-surface-container-low/50 p-4 border border-outline-variant/10 hover:border-primary/30 transition-all group">
                        <div class="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary group-hover:scale-110 transition-transform">
                          <Papicon icon={getConnectionIcon(connection.type)} size={20} />
                        </div>
                        <div class="min-w-0">
                          <p class="text-sm font-semibold text-on-surface truncate">{connection.name}</p>
                          <p class="text-[11px] font-semibold uppercase tracking-widest text-on-surface-variant/40 mt-0.5">{connection.type}</p>
                        </div>
                      </div>
                    {/each}
                    {#if caseData?.connections.length === 0 && (caseData?.interactionGraph?.nodes || []).length === 0}
                      <div class="md:col-span-2 lg:col-span-3 flex flex-col items-center py-20 text-on-surface-variant/30 bg-surface-container-low/30 rounded-xl">
                        <Papicon icon="link-2" size={48} />
                        <p class="mt-4 text-sm font-semibold uppercase tracking-widest">{m.mcm_no_external_link()}</p>
                      </div>
                    {/if}
                  </div>
                </div>

              {:else if activeTab === 'candidatures'}
                <div class="space-y-6">
                  {#each (caseData?.candidatures || []) as cand}
                    <div class="rounded-xl bg-surface-container-low/50 p-8 border border-outline-variant/10 space-y-6">
                      <div class="flex items-start justify-between">
                         <div>
                            <span class="text-xs font-medium text-primary mb-2 block">{formatDateShort(cand.createdAt)}</span>
                            <span class="px-4 py-1.5 rounded-xl text-[13px] font-medium {cand.status === 'APPROVED' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'}">
                              {cand.status}
                            </span>
                         </div>
                         {#if cand.oralResult}
                           <div class="flex flex-col items-end">
                              <span class="text-[11px] font-semibold uppercase tracking-widest text-on-surface-variant/40 mb-1">{m.mcm_oral_result()}</span>
                              <span class="text-sm font-semibold text-on-surface">{cand.oralResult}</span>
                           </div>
                         {/if}
                      </div>
                      {#if cand.notes}
                        <div class="rounded-lg bg-surface-container-high/30 p-5 border-l-4 border-primary italic text-sm text-on-surface-variant leading-relaxed">
                          "{cand.notes}"
                        </div>
                      {/if}
                    </div>
                  {/each}
                  {#if (caseData?.candidatures?.length ?? 0) === 0}
                    <div class="flex flex-col items-center py-20 text-on-surface-variant/30 bg-surface-container-low/30 rounded-xl">
                      <Papicon icon="user-check" size={48} />
                      <p class="mt-4 text-sm font-semibold uppercase tracking-widest">{m.mcm_no_candidature()}</p>
                    </div>
                  {/if}
                </div>

              {:else if activeTab === 'linked_accounts'}
                {#if crossServerLinks?.enabled && crossServerLinkSuggestions.length > 0}
                  <div class="mb-6 rounded-xl bg-surface-container-low/50 border border-outline-variant/10 overflow-hidden shadow-sm">
                    <!-- En-tête -->
                    <div class="flex items-center gap-4 px-6 py-5 border-b border-outline-variant/10">
                      <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-500">
                        <Papicon icon="globe" size={22} />
                      </div>
                      <div class="min-w-0 flex-1">
                        <p class="text-[10px] font-semibold uppercase tracking-wider text-amber-500">{m.mcm_xlink_title()}</p>
                        <p class="text-sm font-semibold text-on-surface">
                          {crossServerLinkSuggestions.length > 1 ? m.mcm_xlink_count_other({ count: crossServerLinkSuggestions.length }) : m.mcm_xlink_count_one({ count: crossServerLinkSuggestions.length })}
                          <span class="text-on-surface-variant/50 font-medium">{crossServerLinks.serverCount > 1 ? m.mcm_xlink_on_other({ count: crossServerLinks.serverCount }) : m.mcm_xlink_on_one({ count: crossServerLinks.serverCount })}</span>
                        </p>
                      </div>
                    </div>

                    <!-- Liste -->
                    <ul class="divide-y divide-outline-variant/10">
                      {#each crossServerLinkSuggestions as suggestion}
                        <li class="flex flex-wrap items-center gap-4 px-6 py-4 hover:bg-surface-container-high/20 transition-colors">
                          {#if suggestion.avatarUrl}
                            <img src={suggestion.avatarUrl} alt={m.mcm_avatar_alt()} class="h-11 w-11 shrink-0 rounded-lg object-cover border-2 border-surface" />
                          {:else}
                            <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-surface-container-high text-sm font-semibold text-primary">
                              {(suggestion.userTag ?? '?').slice(0, 1).toUpperCase()}
                            </div>
                          {/if}

                          <div class="min-w-0 flex-1">
                            <div class="flex flex-wrap items-center gap-2">
                              <span class="text-sm font-semibold text-on-surface truncate">{suggestion.userTag ?? m.mcm_xlink_unknown_user({ id: suggestion.userId })}</span>
                              <span class="inline-flex items-center gap-1.5 rounded-lg bg-surface-container-high px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant">
                                {suggestion.serverCount > 1 ? m.mcm_xlink_servers_other({ count: suggestion.serverCount }) : m.mcm_xlink_servers_one({ count: suggestion.serverCount })}
                              </span>
                              {#if !suggestion.presentOnGuild}
                                <span class="inline-flex items-center rounded-lg bg-surface-container-high px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant/50">
                                  {m.mcm_xlink_absent()}
                                </span>
                              {/if}
                            </div>
                            <p class="mt-0.5 text-[10px] font-bold text-on-surface-variant/40">ID: {suggestion.userId}</p>
                            <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
                              {#each suggestion.guilds as guild}
                                <span
                                  class="inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[11px] font-medium {guild.status === 'VALIDATED' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'}"
                                  title={guild.reason ?? ''}
                                >
                                  <Papicon icon="map-pin" size={11} class="shrink-0 opacity-60" />
                                  <span class="truncate max-w-[14rem]">{guild.guildName}</span>
                                  <span class="opacity-60">· {guild.type === 'MANUAL' ? m.mcm_xlink_manual() : m.mcm_xlink_automatic()}</span>
                                </span>
                              {/each}
                            </div>
                          </div>

                          <div class="flex shrink-0 items-center gap-2">
                            <span class="inline-flex items-center rounded-lg bg-surface-container-high px-2.5 py-1 text-[11px] font-semibold text-on-surface-variant" title={m.mcm_xlink_score_hint()}>
                              {m.mcm_xlink_score({ score: suggestion.score })}
                            </span>
                            {#if suggestion.alreadyLinkedHere}
                              <span class="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-widest text-emerald-500">
                                <Papicon icon="check" size={12} />
                                {m.mcm_xlink_already_linked()}
                              </span>
                            {:else}
                              <button
                                class="px-4 py-2 rounded-xl text-[11px] font-semibold uppercase tracking-widest transition-all duration-300 {applyingSuggestionId !== null ? 'bg-surface-container-high text-on-surface-variant/50 cursor-not-allowed' : 'bg-primary text-on-primary hover:bg-primary/90 hover:scale-[1.02] active:scale-95 cursor-pointer'}"
                                onclick={() => handleApplySuggestedLink(suggestion)}
                                disabled={applyingSuggestionId !== null}
                              >
                                {#if applyingSuggestionId === suggestion.userId}
                                  <div class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-on-surface-variant border-t-transparent"></div>
                                {:else}
                                  {m.mcm_xlink_apply()}
                                {/if}
                              </button>
                            {/if}
                          </div>
                        </li>
                      {/each}
                    </ul>

                    <!-- Pied -->
                    <div class="flex items-center justify-between gap-3 px-6 py-3 border-t border-outline-variant/10 bg-surface-container-low/30">
                      <p class="flex items-center gap-1.5 text-[11px] font-medium text-on-surface-variant/40">
                        <Papicon icon="lock" size={12} class="shrink-0" />
                        {m.mcm_same_instance()}
                      </p>
                      <p class="text-[11px] font-medium text-on-surface-variant/40 text-right">{m.mcm_xlink_footer_hint()}</p>
                    </div>
                  </div>
                {/if}

                <div class="mb-8 rounded-xl bg-surface-container-low/50 p-6 border border-outline-variant/10">
                  <h3 class="text-sm font-semibold text-on-surface mb-4 flex items-center gap-2"><Papicon icon="link-2" size={16} /> {m.mcm_link_account_manually()}</h3>
                  <div class="grid gap-4 md:grid-cols-2">
                    <FormInput 
                      id="targetAccountId" 
                      label={m.mcm_target_account_id()} 
                      bind:value={targetAccountId} 
                      placeholder="Ex: 123456789012345678" 
                      icon="user-plus" 
                      required 
                    />
                    <FormInput 
                      id="linkReason" 
                      label={m.mcm_link_reason_label()} 
                      bind:value={linkReason} 
                      placeholder={m.mcm_link_reason_placeholder()} 
                      icon="file-text" 
                    />
                  </div>
                  
                  {#if linkFeedback}
                    <div class="mt-4 p-3 rounded-xl text-sm font-bold {linkIsError ? 'bg-red-500/10 text-red-400' : 'bg-emerald-500/10 text-emerald-400'}">
                      {linkFeedback}
                    </div>
                  {/if}
                  
                  <div class="mt-4 flex justify-end">
                    <button 
                      class="px-6 py-2 rounded-xl text-sm font-semibold tracking-widest uppercase transition-all duration-300 {linkBusy || !targetAccountId ? 'bg-surface-container-high text-on-surface-variant/50 cursor-not-allowed' : 'bg-primary text-on-primary hover:bg-primary/90 hover:scale-[1.02] active:scale-95'}"
                      onclick={handleLinkAccount}
                      disabled={linkBusy || !targetAccountId}
                    >
                      {#if linkBusy}
                        <div class="flex items-center gap-2">
                          <div class="h-4 w-4 animate-spin rounded-full border-2 border-on-primary border-t-transparent"></div>
                          <span>{m.mcm_linking()}</span>
                        </div>
                      {:else}
                        {m.mcm_link_accounts()}
                      {/if}
                    </button>
                  </div>
                </div>

                <div class="grid gap-6 md:grid-cols-2">
                  {#each caseData?.linkedAccounts || [] as link}
                    <div class="rounded-xl bg-surface-container-low/50 p-6 border border-outline-variant/10 shadow-sm hover:bg-surface-container-low transition-all duration-500 group flex items-center gap-4">
                      {#if link.avatarUrl}
                        <img src={link.avatarUrl} alt={m.mcm_avatar_alt()} class="h-16 w-16 rounded-lg object-cover shadow-lg border-2 border-surface" />
                      {:else}
                        <div class="flex h-16 w-16 items-center justify-center rounded-lg bg-surface-container-high text-xl font-semibold text-primary">
                          {link.userTag?.slice(0, 1).toUpperCase()}
                        </div>
                      {/if}
                      <div class="min-w-0 flex-1">
                        <div class="flex items-center justify-between">
                           <p class="text-sm font-semibold text-on-surface truncate">{link.userTag}</p>
                           <div class="flex items-center gap-2">
                             <span class="px-2 py-0.5 rounded-lg text-[11px] font-semibold uppercase tracking-widest {link.status === 'VALIDATED' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'}">
                               {link.status}
                             </span>
                             {#if dashboardStore.state.access.level === 'admin'}
                               <button 
                                 class="p-1.5 rounded-lg text-red-500 hover:bg-red-500/10 transition-colors cursor-pointer disabled:opacity-50"
                                 title={m.mcm_unlink_account()}
                                 onclick={() => handleUnlinkAccount(link.userId)}
                                 disabled={unlinkingAccountId === link.userId}
                               >
                                 {#if unlinkingAccountId === link.userId}
                                   <div class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-red-500 border-t-transparent"></div>
                                 {:else}
                                   <Papicon icon="trash-2" size={14} />
                                 {/if}
                               </button>
                             {/if}
                           </div>
                        </div>
                        <p class="text-[10px] font-bold text-on-surface-variant/40 mt-1">ID: {link.userId}</p>
                        <p class="text-[10px] font-semibold text-primary uppercase tracking-widest mt-1">{link.type}</p>
                      </div>
                    </div>
                  {/each}
                  {#if (caseData?.linkedAccounts || []).length === 0}
                    <div class="md:col-span-2 flex flex-col items-center py-20 text-on-surface-variant/30 bg-surface-container-low/30 rounded-xl">
                      <div class="flex h-16 w-16 items-center justify-center rounded-xl bg-surface-container-high text-on-surface-variant/20 mb-6">
                        <Papicon icon="user-plus" size={32} />
                      </div>
                      <p class="mt-4 text-sm font-semibold uppercase tracking-widest">{m.mcm_no_linked_account()}</p>
                    </div>
                  {/if}
                </div>
              {:else if activeTab === 'notes'}
                <div class="space-y-6">
                  <div class="rounded-xl bg-surface-container-low/50 p-8 border border-outline-variant/10 shadow-sm">
                    <div class="flex items-center gap-3 mb-6">
                      <div class="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <Papicon icon="edit-3" size={24} />
                      </div>
                      <div>
                        <p class="text-[10px] font-semibold uppercase tracking-wider text-primary">{m.mcm_moderation()}</p>
                        <p class="text-lg font-semibold text-on-surface">{m.mcm_mod_notes()}</p>
                      </div>
                    </div>

                    <p class="text-sm text-on-surface-variant/70 mb-6 leading-relaxed">
                      {m.mcm_mod_notes_desc()}
                    </p>

                    <div class="relative group">
                      <label for="moderator-note-textarea" class="sr-only">{m.mcm_mod_notes_sr()}</label>
                      <textarea
                        id="moderator-note-textarea"
                        bind:value={moderatorNote}
                        placeholder={m.mcm_add_note_placeholder()}
                        class="w-full min-h-[300px] rounded-xl bg-surface-container-high/50 p-6 text-sm text-on-surface placeholder:text-on-surface-variant/30 border-2 border-transparent focus:border-primary/30 focus:bg-surface-container-high transition-all outline-hidden resize-none"
                      ></textarea>
                    </div>

                    <div class="mt-6 flex items-center justify-between">
                      <div class="flex items-center gap-2">
                        {#if noteFeedback}
                          <span class="text-xs font-bold {noteFeedback.includes('Erreur') ? 'text-rose-400' : 'text-emerald-400'} animate-in fade-in slide-in-from-left-2">
                            {noteFeedback}
                          </span>
                        {/if}
                      </div>
                      <button
                        onclick={handleSaveNote}
                        disabled={noteBusy}
                        class="flex items-center gap-2 px-8 py-3 rounded-lg bg-primary text-on-primary text-sm font-semibold uppercase tracking-widest transition-all hover:bg-primary/90 hover:scale-[1.02] active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                      >
                        {#if noteBusy}
                          <div class="h-4 w-4 animate-spin rounded-full border-2 border-on-primary border-t-transparent"></div>
                          <span>{m.mcm_saving()}</span>
                        {:else}
                          <Papicon icon="save" size={18} />
                          <span>{m.mcm_save()}</span>
                        {/if}
                      </button>
                    </div>
                  </div>
                </div>
              {/if}
            </div> <!-- Fin Colonne Principale -->

            <!-- Colonne Latérale (Statistiques & Actions de modération) -->
            <aside class="lg:col-span-1 space-y-6 lg:sticky lg:top-16">
              
              <!-- 1. Carte Score de Risque & Ancienneté -->
              <div class="rounded-xl bg-surface-container-low/50 p-6 border border-outline-variant/10 shadow-sm space-y-5">
                <div class="flex items-center justify-between border-b border-outline-variant/5 pb-3">
                  <span class="text-xs font-bold text-on-surface-variant/60 uppercase tracking-widest">{m.mcm_risk_score()}</span>
                  <span class="text-xs font-semibold text-primary">{memberSeniority}</span>
                </div>

                <!-- Jauge de risque -->
                <div class="flex items-center gap-4">
                  <div class="relative flex items-center justify-center shrink-0">
                    <svg class="h-16 w-16 transform -rotate-90">
                      <circle cx="32" cy="32" r="28" class="stroke-on-surface/5 fill-transparent" stroke-width="6" />
                      <circle cx="32" cy="32" r="28" 
                        class="transition-all duration-1000 ease-out {moderationRiskScore < 30 ? 'stroke-emerald-500' : moderationRiskScore < 70 ? 'stroke-amber-500' : 'stroke-red-500'} fill-transparent" 
                        stroke-width="6" 
                        stroke-dasharray="{2 * Math.PI * 28}" 
                        stroke-dashoffset="{(1 - moderationRiskScore / 100) * (2 * Math.PI * 28)}" 
                        stroke-linecap="round"
                      />
                    </svg>
                    <span class="absolute text-sm font-bold text-on-surface">{moderationRiskScore}%</span>
                  </div>

                  <div class="min-w-0">
                    <h5 class="text-xs font-bold text-on-surface truncate">
                      {#if moderationRiskScore < 30}
                        {m.mcm_risk_low()}
                      {:else if moderationRiskScore < 70}
                        {m.mcm_risk_high()}
                      {:else}
                        {m.mcm_risk_critical()}
                      {/if}
                    </h5>
                    <p class="text-[10px] text-on-surface-variant/60 mt-0.5 leading-relaxed">
                      {m.mcm_risk_desc()}
                    </p>
                  </div>
                </div>
              </div>

              <!-- 2. Carte Top Salons d'Activité -->
              {#if topChannels.length > 0}
                <div class="rounded-xl bg-surface-container-low/50 p-6 border border-outline-variant/10 shadow-sm space-y-4">
                  <span class="text-xs font-bold text-on-surface-variant/60 uppercase tracking-widest block border-b border-outline-variant/5 pb-3">{m.mcm_top_channels()}</span>
                  
                  <div class="space-y-3.5">
                    {#each topChannels as chan}
                      {@const totalMsg = caseData?.profile?.messageCount || 1}
                      {@const pct = Math.round((chan.count / totalMsg) * 100)}
                      <button
                        type="button"
                        onclick={() => channelDetailsModal.show(chan.channelId, chan.channelName)}
                        class="w-full space-y-1.5 text-left group/chan"
                        title={m.mcm_open_channel_details()}
                      >
                        <div class="flex items-center justify-between text-xs">
                          <span class="font-semibold text-on-surface truncate max-w-[120px] group-hover/chan:text-primary transition-colors">#{chan.channelName}</span>
                          <span class="font-bold text-on-surface-variant/60">{chan.count} msg ({pct}%)</span>
                        </div>
                        <div class="h-1.5 w-full rounded-full bg-on-surface/5 overflow-hidden">
                          <div class="h-full bg-primary/70 transition-all duration-500" style="width: {pct}%"></div>
                        </div>
                      </button>
                    {/each}
                  </div>
                </div>
              {/if}

              <!-- 3. Actions de modération -->
              <div class="rounded-xl bg-surface-container-low/50 p-6 border border-outline-variant/10 shadow-sm space-y-5">
                <span class="text-xs font-bold text-on-surface-variant/60 uppercase tracking-widest block border-b border-outline-variant/5 pb-3">{m.mcm_mod_actions()}</span>

                <!-- Raison -->
                <div class="space-y-1.5">
                  <label for="mod-reason" class="text-[11px] font-bold text-on-surface-variant/50 uppercase tracking-wider">{m.mcm_sanction_reason()}</label>
                  <textarea
                    id="mod-reason"
                    bind:value={actionReason}
                    rows="3"
                    placeholder={m.mcm_reason_placeholder()}
                    class="w-full rounded-lg bg-surface-container-high/40 px-3 py-2 text-xs font-semibold text-on-surface border border-outline-variant/10 focus:border-primary/50 outline-hidden transition-all resize-none"
                  ></textarea>
                </div>

                <!-- Durée (pour Timeout) -->
                <div class="space-y-1.5">
                  <label for="mod-duration" class="text-[11px] font-bold text-on-surface-variant/50 uppercase tracking-wider">{m.mcm_duration_timeout()}</label>
                  <div class="relative">
                    <select
                      id="mod-duration"
                      bind:value={actionDuration}
                      class="w-full appearance-none rounded-lg border border-outline-variant/10 bg-surface-container-high/40 py-2 pl-3 pr-8 text-xs font-bold text-on-surface focus:border-primary/30 focus:outline-hidden"
                    >
                      <option value="30m">{m.mcm_duration_30m()}</option>
                      <option value="1h">{m.mcm_duration_1h()}</option>
                      <option value="1d">{m.mcm_duration_1d()}</option>
                      <option value="7d">{m.mcm_duration_7d()}</option>
                      <option value="28d">{m.mcm_duration_28d()}</option>
                    </select>
                    <span class="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-on-surface-variant/40">
                      <Papicon icon="chevron-down" size={12} />
                    </span>
                  </div>
                </div>

                <!-- Grille d'actions boutons -->
                <div class="grid grid-cols-2 gap-2.5 pt-2">
                  <button
                    type="button"
                    onclick={() => executeModerationAction('WARN')}
                    disabled={actionBusy}
                    class="flex items-center justify-center gap-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 active:scale-95 disabled:opacity-50 disabled:pointer-events-none px-3 py-2.5 text-xs font-bold text-white transition-all shadow-xs cursor-pointer"
                  >
                    <Papicon icon="alert-triangle" size={14} />
                    {m.mcm_action_warn()}
                  </button>

                  <button
                    type="button"
                    onclick={() => executeModerationAction('TIMEOUT')}
                    disabled={actionBusy}
                    class="flex items-center justify-center gap-1.5 rounded-lg bg-sky-500 hover:bg-sky-600 active:scale-95 disabled:opacity-50 disabled:pointer-events-none px-3 py-2.5 text-xs font-bold text-white transition-all shadow-xs cursor-pointer"
                  >
                    <Papicon icon="clock" size={14} />
                    {m.mcm_action_timeout()}
                  </button>

                  <button
                    type="button"
                    onclick={() => executeModerationAction('KICK')}
                    disabled={actionBusy}
                    class="flex items-center justify-center gap-1.5 rounded-lg bg-orange-500 hover:bg-orange-600 active:scale-95 disabled:opacity-50 disabled:pointer-events-none px-3 py-2.5 text-xs font-bold text-white transition-all shadow-xs cursor-pointer col-span-1"
                  >
                    <Papicon icon="log-out" size={14} />
                    {m.mcm_action_kick()}
                  </button>

                  <button
                    type="button"
                    onclick={() => executeModerationAction('BAN')}
                    disabled={actionBusy}
                    class="flex items-center justify-center gap-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 active:scale-95 disabled:opacity-50 disabled:pointer-events-none px-3 py-2.5 text-xs font-bold text-white transition-all shadow-xs cursor-pointer col-span-1"
                  >
                    <Papicon icon="gavel" size={14} />
                    {m.mcm_action_ban()}
                  </button>
                </div>

                <!-- Feedback / Status box -->
                {#if actionFeedback}
                  <div class="rounded-lg border p-3 text-xs font-medium {actionIsError ? 'border-red-500/20 bg-red-500/5 text-red-500' : 'border-emerald-500/20 bg-emerald-500/5 text-emerald-500'} flex items-center gap-2">
                    <Papicon icon={actionIsError ? 'alert-circle' : 'check-circle'} size={14} />
                    <span>{actionFeedback}</span>
                  </div>
                {/if}
              </div>
            </aside>
          </div>
        {/if}
      </div>

    </div>

    {#if viewingReportSanctionId && selectedSanctionForReport}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div 
        class="member-case-overlay fixed inset-0 flex items-center justify-center bg-surface-container-lowest/90 animate-in fade-in duration-300"
        onclick={(e) => e.stopPropagation()}
      >
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div 
          class="w-full max-w-2xl bg-surface-container-low rounded-xl border border-outline-variant/10 shadow-sm p-8 max-h-[90%] overflow-y-auto relative"
          onclick={(e) => e.stopPropagation()}
        >
          <button
            onclick={() => viewingReportSanctionId = null}
            class="absolute top-6 right-6 h-10 w-10 flex items-center justify-center rounded-xl bg-on-surface/5 text-on-surface-variant transition-all hover:bg-on-surface/10 hover:text-on-surface"
          >
            <Papicon icon="x" size={20} />
          </button>

          <div class="mb-8">
            <p class="text-[10px] font-semibold uppercase tracking-wider text-primary mb-1">{m.mcm_sanction_report()}</p>
            <h4 class="text-2xl font-semibold text-on-surface font-headline">{formatTypeLabel(selectedSanctionForReport.type)}</h4>
            <p class="text-xs text-on-surface-variant/60 mt-1">{m.mcm_applied_on({ date: formatDateTime(selectedSanctionForReport.createdAt), moderator: selectedSanctionForReport.moderatorTag })}</p>
          </div>

          {#if selectedReport}
            {#if isEditingReport}
              <!-- Edit Form -->
               <div class="space-y-6 animate-in fade-in duration-300">
                 <div class="grid grid-cols-2 gap-4">
                   <div class="space-y-1.5">
                     <p class="text-xs font-medium text-on-surface-variant/40 px-1">{m.mcm_incident_date()}</p>
                     <input 
                       type="datetime-local" 
                       bind:value={editReportData.incidentAt} 
                       class="w-full rounded-lg bg-surface-container-high px-4 py-3 text-xs font-bold text-on-surface border border-outline-variant/10 focus:border-primary/50 outline-hidden transition-all"
                     />
                   </div>
                   <div class="space-y-1.5">
                     <p class="text-xs font-medium text-on-surface-variant/40 px-1">{m.mcm_applied_duration()}</p>
                     <input 
                       type="text" 
                       bind:value={editReportData.sanctionDurationLabel} 
                       placeholder={m.mcm_duration_placeholder()} 
                       class="w-full rounded-lg bg-surface-container-high px-4 py-3 text-xs font-bold text-on-surface border border-outline-variant/10 focus:border-primary/50 outline-hidden transition-all"
                     />
                   </div>
                 </div>

                 <div class="space-y-1.5">
                   <p class="text-xs font-medium text-on-surface-variant/40 px-1">{m.mcm_broken_rules()}</p>
                   <ReportRuleSelector
                     id="member-case-report-rules"
                     options={reportRuleOptions}
                     selectedIds={editReportData.selectedRuleIds}
                     onToggle={(id, checked) => {
                       if (checked) {
                         editReportData.selectedRuleIds = [...new Set([...editReportData.selectedRuleIds, id])];
                       } else {
                         editReportData.selectedRuleIds = editReportData.selectedRuleIds.filter(v => v !== id);
                       }
                     }}
                   />
                   <SelectedRuleChips selectedRules={editDraftRules} />
                 </div>

                 <div class="space-y-1.5">
                   <p class="text-xs font-medium text-on-surface-variant/40 px-1">{m.mcm_detailed_reason()}</p>
                   <textarea 
                     bind:value={editReportData.detailedReason} 
                     rows="4"
                     placeholder={m.mcm_detailed_reason_placeholder()} 
                     class="w-full rounded-lg bg-surface-container-high px-4 py-3 text-xs font-bold text-on-surface border border-outline-variant/10 focus:border-primary/50 outline-hidden transition-all resize-none"
                   ></textarea>
                 </div>

                 <div class="space-y-1.5">
                   <p class="text-xs font-medium text-on-surface-variant/40 px-1">Preuves (URLs)</p>
                   <EvidenceInputList bind:links={editReportData.evidenceLinks} sanctionId={viewingReportSanctionId} />
                 </div>

                 <div class="space-y-1.5">
                   <p class="text-xs font-medium text-on-surface-variant/40 px-1">{m.mcm_extra_notes()}</p>
                   <textarea 
                     bind:value={editReportData.additionalNotes} 
                     rows="2"
                     placeholder={m.mcm_extra_notes_placeholder()} 
                     class="w-full rounded-lg bg-surface-container-high px-4 py-3 text-xs font-bold text-on-surface border border-outline-variant/10 focus:border-primary/50 outline-hidden transition-all resize-none"
                   ></textarea>
                 </div>

                 <div class="flex gap-3 pt-4">
                   <button
                     onclick={() => isEditingReport = false}
                     class="flex-1 py-3 rounded-xl bg-on-surface/5 text-[13px] font-medium text-on-surface-variant transition-all hover:bg-on-surface/10"
                   >
                     {m.common_cancel()}
                   </button>
                   <button
                     onclick={handleUpdateReport}
                     disabled={updateReportBusy}
                     class="flex-1 py-3 rounded-xl bg-primary text-on-primary text-[13px] font-medium transition-all hover:bg-primary-container hover:text-primary disabled:opacity-50"
                   >
                     {updateReportBusy ? m.mcm_saving() : m.common_save()}
                   </button>
                 </div>
               </div>
            {:else}
              <!-- View Mode -->
              <div class="space-y-6">
                <div class="grid grid-cols-2 gap-4">
                  <div class="space-y-1">
                    <p class="text-xs font-medium text-on-surface-variant/40">{m.mcm_incident()}</p>
                    <p class="text-sm font-bold text-on-surface">{formatDateTime(selectedReport.incidentAt)}</p>
                  </div>
                  <div class="space-y-1">
                    <p class="text-xs font-medium text-on-surface-variant/40">{m.mcm_duration()}</p>
                    <p class="text-sm font-bold text-on-surface">{selectedReport.sanctionDurationLabel || 'N/A'}</p>
                  </div>
                </div>

                <div class="space-y-2">
                  <p class="text-xs font-medium text-on-surface-variant/40">{m.mcm_broken_rules()}</p>
                  <SelectedRuleChips selectedRules={selectedReportRules} />
                </div>

                <div class="space-y-2">
                  <p class="text-xs font-medium text-on-surface-variant/40">{m.mcm_detailed_reason()}</p>
                  <div class="rounded-lg bg-surface-container-high/30 p-4 text-sm text-on-surface-variant leading-relaxed italic">
                    "{selectedReport.detailedReason}"
                  </div>
                </div>

                {#if selectedReport.evidenceLinks && selectedReport.evidenceLinks.length > 0}
                  <div class="space-y-2">
                    <p class="text-xs font-medium text-on-surface-variant/40">{m.mcm_evidence()}</p>
                    <div class="flex flex-wrap gap-2">
                      {#each selectedReport.evidenceLinks as link}
                        <a href={link} target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-2 rounded-xl bg-on-surface/5 px-4 py-2 text-xs font-bold text-primary transition-all hover:bg-primary/10">
                          <Papicon icon="external-link" size={14} />
                          {m.mcm_evidence_link()}
                        </a>
                      {/each}
                    </div>
                  </div>
                {/if}

                {#if selectedReport.additionalNotes}
                  <div class="space-y-2">
                    <p class="text-xs font-medium text-on-surface-variant/40">{m.mcm_extra_notes()}</p>
                    <p class="text-xs text-on-surface-variant/70 leading-relaxed">{selectedReport.additionalNotes}</p>
                  </div>
                {/if}

                <div class="pt-4 flex flex-col items-center gap-4 border-t border-outline-variant/10">
                  <p class="text-[10px] font-bold text-on-surface-variant/30 text-center">{m.mcm_report_by({ author: selectedReport.createdByTag || selectedReport.createdByUserId })}</p>
                  
                  {#if selectedReport.createdByUserId === authStore.user?.userId || authStore.isAdmin}
                    <button
                      onclick={() => startEditingReport(selectedReport)}
                      class="inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-2.5 text-[10px] font-semibold text-on-primary uppercase tracking-widest transition-all hover:bg-primary-container hover:scale-[1.02] active:scale-[0.98] shadow-xs cursor-pointer"
                    >
                      <Papicon icon="edit-3" size={14} />
                      {m.mcm_edit_report()}
                    </button>
                  {/if}
                </div>
              </div>
            {/if}

          {:else}
            <div class="flex flex-col items-center justify-center py-10 text-center">
              <div class="h-16 w-16 rounded-full bg-amber-500/10 text-amber-500 flex items-center justify-center mb-4">
                <Papicon icon="alert-triangle" size={32} />
              </div>
              <p class="text-sm font-semibold text-on-surface-variant">{m.mcm_report_missing()}</p>
              <p class="text-xs text-on-surface-variant/40 mt-1 max-w-xs">{m.mcm_report_missing_desc()}</p>
            </div>
          {/if}

          <button
            onclick={() => viewingReportSanctionId = null}
            class="w-full mt-8 py-4 rounded-lg bg-on-surface/5 text-sm font-semibold uppercase tracking-widest text-on-surface-variant transition-all hover:bg-on-surface/10 hover:text-on-surface"
          >
            {m.mcm_close_details()}
          </button>
        </div>
      </div>
    {/if}

</Modal>
