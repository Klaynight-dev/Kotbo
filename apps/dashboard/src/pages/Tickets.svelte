<script lang="ts">
  import { m, dateLocale } from '../lib/i18n';
  import { channelDisplayName } from '../lib/channelUtils';
  import { onMount, onDestroy } from 'svelte';
  import { router } from 'tinro';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { authStore } from '../lib/stores/auth.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { isMissingReference } from '../lib/discordReferences';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import { useUnsavedChanges } from '../lib/useUnsavedChanges.svelte';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import { subscribeRealtime } from '../lib/stores/realtime.svelte';
  import {
    API_BASE_URL,
    fetchMemberCase,
    runMemberCaseAction,
    fetchSatisfactionData,
    fetchStaffSatisfactionReviews,
    fetchStaffServerChannels
  } from '../lib/api';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import FormInput from '../lib/components/FormInput.svelte';
  import FormTextarea from '../lib/components/FormTextarea.svelte';
  import FormSelect from '../lib/components/FormSelect.svelte';
  import MultiSelect from '../lib/components/MultiSelect.svelte';
  import FormColorPicker from '../lib/components/FormColorPicker.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import ActionButton from '../lib/components/ActionButton.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import Modal from '../lib/components/Modal.svelte';

  // Navigation & Tabs
  const ticketsTabs = ['tickets', 'transcripts', 'satisfaction', 'macros', 'blacklist', 'config'] as const;
  const DEFAULT_TICKETS_TAB = 'tickets';
  let activeTab = $state<'tickets' | 'transcripts' | 'satisfaction' | 'macros' | 'blacklist' | 'config'>(DEFAULT_TICKETS_TAB);

  $effect(() => {
    const _path = $router.path;
    activeTab = resolveTabFromUrl('/tickets', ticketsTabs, DEFAULT_TICKETS_TAB) as typeof activeTab;
  });

  const TICKETS_PAGE_SIZE = 75;
  let ticketsOffset = $state(0);
  let ticketsHasMore = $state(false);
  let loadingMoreTickets = $state(false);
  type TicketFilter = 'ALL' | 'PENDING' | 'OPEN' | 'CLAIMED' | 'CLOSED' | 'ARCHIVED' | 'REJECTED';
  let ticketFilter = $state<TicketFilter>('ALL');
  
  // Data State
  let tickets = $state<any[]>([]);
  let transcripts = $state<any[]>([]);
  let config = $state<any>({});
  let selectedTicketId = $state<string | null>(null);
  let selectedTicketDetail = $state<any>(null);
  let signedTranscriptUrl = $state<string | null>(null);
  let messages = $state<any[]>([]);
  
  // Loading & Error State
  let loading = $state(true);
  let loadingDetail = $state(false);
  let error = $state('');
  
  // Forms & Actions State
  let chatInput = $state('');
  let closeReason = $state('');
  let ticketRenameName = $state('');
  let showCloseModal = $state(false);
  let showDeleteConfirmModal = $state(false);
  let chatScrollContainer = $state<HTMLDivElement | null>(null);
  let unsubscribeRealtime: (() => void) | null = null;
  
  // Configuration Bindings
  let ticketCategoryId = $state('');
  let ticketLogChannelId = $state('');
  let ticketStaffRoleId = $state('');
  let ticketChannelId = $state('');
  let ticketEmbedTitle = $state('');
  let ticketEmbedDesc = $state('');
  let ticketEmbedButtonText = $state('');
  let ticketEmbedColor = $state('');
  let ticketEmbedType = $state<'BUTTONS' | 'DROPDOWN'>('BUTTONS');
  let ticketMode = $state<'CHANNEL' | 'DM' | 'THREAD'>('CHANNEL');
  let ticketDmRelayChannelId = $state('');
  let ticketAllowOverclaim = $state(true);
  let ticketOverclaimPermission = $state('ANY');
  let ticketAutoClaimOnReply = $state(false);
  let ticketInactivityEnabled = $state(false);
  let ticketInactivityHours = $state(24);
  let ticketInactivityMessage = $state('');
  let ticketSatisfactionCommentEnabled = $state(true);
  let ticketSatisfactionCommentQuestion = $state('');
  let ticketSatisfactionCommentTimeout = $state(120);
  let ticketSatisfactionLogChannelId = $state('');
  let ticketSatisfactionLogAnonymous = $state(false);
  let ticketLockUntilClaim = $state(false);
  let ticketApprovalEnabled = $state(false);
  let ticketApprovalChannelId = $state('');
  let ticketArchiveCategoryId = $state('');
  let ticketArchiveKeepOpenerView = $state(false);
  let ticketHistoryPanelEnabled = $state(true);
  let ticketSelfReopenEnabled = $state(true);
  let ticketSelfDeleteEnabled = $state(false);
  // ── Quotas tickets : chaque interrupteur commande, la valeur est un seuil.
  let ticketQuotaOpenEnabled = $state(false);
  let ticketQuotaOpenMax = $state(1);
  let ticketQuotaCooldownEnabled = $state(false);
  let ticketQuotaCooldownMinutes = $state(30);
  let ticketQuotaPeriodEnabled = $state(false);
  let ticketQuotaPeriodMax = $state(5);
  let ticketQuotaPeriodHours = $state(24);
  let ticketQuotaStaffLoadMode = $state('OFF');
  let ticketQuotaStaffLoadMax = $state(5);
  let ticketQuotaStaffLoadBypassRoleIds = $state([] as string[]);
  let ticketQuotaReopenEnabled = $state(false);
  let ticketQuotaReopenMax = $state(3);
  let ticketEmbedThumbnail = $state('');
  let ticketEmbedImage = $state('');
  let ticketEmbedFooter = $state('');
  let ticketEmbedAuthorName = $state('');
  let ticketEmbedAuthorIcon = $state('');
  let ticketWelcomeTitle = $state('');
  let ticketWelcomeDesc = $state('');
  let ticketWelcomeColor = $state('');
  let ticketWelcomeThumbnail = $state('');
  let ticketWelcomeImage = $state('');
  let ticketWelcomeFooter = $state('');
  let ticketTypes = $state<Array<{
    id: string;
    label: string;
    description: string;
    emoji: string;
    categoryId: string;
    staffRoleId: string;
    buttonStyle: 'PRIMARY' | 'SECONDARY' | 'SUCCESS' | 'DANGER';
    mode: '' | 'CHANNEL' | 'DM' | 'THREAD';
    anonymous: boolean;
    staffServerRelay: boolean;
    staffServerChannel: boolean;
    staffServerCategoryId: string;
    /** Tri-etat : '' herite du serveur, 'YES'/'NO' tranchent pour ce type. */
    lockUntilClaim: '' | 'YES' | 'NO';
    requireApproval: '' | 'YES' | 'NO';
    formEnabled: boolean;
    formCustomFields: Array<{
      id: string;
      label: string;
      placeholder: string;
      style: 'SHORT' | 'PARAGRAPH' | 'SELECT' | 'RADIO' | 'FILE';
      required: boolean;
      choices?: string[];
      choicesString?: string;
    }>;
  }>>([]);

  // Config sections accordion
  let expandedConfigSection = $state<string | null>('mode');
  let expandedTicketTypeIndex = $state<number | null>(null);
  let showMobileChat = $state(false);

  // Satisfaction State
  let satisfactionLoading = $state(false);
  let satisfactionData: any = $state(null);

  type SatisfactionPerson = {
    userId: string;
    username?: string | null;
    displayName?: string | null;
    avatarUrl?: string | null;
  };

  const ratingEmojis = ['', '\u{1F621}', '\u{1F615}', '\u{1F610}', '\u{1F642}', '\u{1F929}'];
  const ratingLabels = ['', m.e1_tickets_sat_rating_1(), m.e1_tickets_sat_rating_2(), m.e1_tickets_sat_rating_3(), m.e1_tickets_sat_rating_4(), m.e1_tickets_sat_rating_5()];

  function getSatisfactionPersonName(person: SatisfactionPerson | null | undefined, userId: string): string {
    return person?.displayName || person?.username || m.e1_tickets_sat_user_fallback({ userId });
  }

  function getSatisfactionPersonHandle(person: SatisfactionPerson | null | undefined, userId: string): string {
    return person?.username ? `@${person.username}` : m.e1_tickets_sat_user_id({ userId });
  }

  function getSatisfactionInitials(person: SatisfactionPerson | null | undefined, userId: string): string {
    const name = getSatisfactionPersonName(person, userId).trim();
    const initials = name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('');
    return initials || userId.slice(0, 2);
  }

  function openSatisfactionMember(userId: string, person: SatisfactionPerson | null | undefined) {
    openMemberCase(userId, getSatisfactionPersonName(person, userId));
  }

  function getRatingColor(rating: number): string {
    if (rating >= 4.5) return 'var(--color-success)';
    if (rating >= 3.5) return 'var(--color-primary, #5865F2)';
    if (rating >= 2.5) return 'var(--color-warning)';
    return 'var(--color-error)';
  }

  async function loadSatisfaction() {
    satisfactionLoading = true;
    try {
      satisfactionData = await fetchSatisfactionData();
    } catch {
      toast.error(m.e1_tickets_err_load_satisfaction());
    } finally {
      satisfactionLoading = false;
    }
  }

  // Ligne staff depliee : apercu des derniers commentaires deja charges avec la vue.
  let expandedStaffId = $state<string | null>(null);

  function toggleStaffComments(staffId: string) {
    expandedStaffId = expandedStaffId === staffId ? null : staffId;
  }

  // Modale « Voir tous les avis » : la liste complete est paginee cote serveur.
  const STAFF_REVIEWS_PAGE_SIZE = 20;
  let reviewsModalStaff = $state<{ staffId: string; staff: SatisfactionPerson | null } | null>(null);
  let reviewsModalItems = $state<any[]>([]);
  let reviewsModalTotal = $state(0);
  let reviewsModalOffset = $state(0);
  let reviewsModalHasMore = $state(false);
  let reviewsModalLoading = $state(false);
  let reviewsModalCommentsOnly = $state(false);

  async function fetchReviewsPage(offset: number, append: boolean) {
    if (!reviewsModalStaff) return;
    reviewsModalLoading = true;
    try {
      const page = await fetchStaffSatisfactionReviews(reviewsModalStaff.staffId, {
        limit: STAFF_REVIEWS_PAGE_SIZE,
        offset,
        commentsOnly: reviewsModalCommentsOnly
      });
      reviewsModalItems = append ? [...reviewsModalItems, ...(page.reviews ?? [])] : (page.reviews ?? []);
      reviewsModalTotal = page.total ?? 0;
      reviewsModalHasMore = page.hasMore === true;
      reviewsModalOffset = offset + (page.reviews?.length ?? 0);
    } catch {
      toast.error(m.e1_tickets_err_load_satisfaction());
    } finally {
      reviewsModalLoading = false;
    }
  }

  function openStaffReviews(staffId: string, staff: SatisfactionPerson | null) {
    reviewsModalStaff = { staffId, staff };
    reviewsModalItems = [];
    reviewsModalTotal = 0;
    reviewsModalOffset = 0;
    reviewsModalHasMore = false;
    reviewsModalCommentsOnly = false;
    void fetchReviewsPage(0, false);
  }

  function closeStaffReviews() {
    reviewsModalStaff = null;
    reviewsModalItems = [];
  }

  function toggleReviewsCommentsOnly() {
    reviewsModalCommentsOnly = !reviewsModalCommentsOnly;
    void fetchReviewsPage(0, false);
  }

  function toggleConfigSection(section: string) {
    expandedConfigSection = expandedConfigSection === section ? null : section;
  }

  // Member Case Modal Integration
  let caseModalOpen = $state(false);
  let selectedCaseUser = $state<{ name: string; id: string | null } | null>(null);
  let selectedCaseData = $state<any>(null);
  let selectedCaseLoading = $state(false);
  let selectedCaseError = $state('');
  let memberActionReason = $state(m.e1_tickets_member_action_default_reason());
  let memberActionDuration = $state('30m');
  let memberActionBusy = $state(false);
  let memberActionFeedback = $state('');
  let memberActionIsError = $state(false);

  let savedSettingsConfig = $state<any>(null);

  const currentSettings = $derived({
    ticketCategoryId,
    ticketLogChannelId,
    ticketStaffRoleId,
    ticketChannelId,
    ticketEmbedTitle,
    ticketEmbedDesc,
    ticketEmbedButtonText,
    ticketEmbedColor,
    ticketEmbedType,
    ticketMode,
    ticketDmRelayChannelId,
    ticketAllowOverclaim,
    ticketOverclaimPermission,
    ticketAutoClaimOnReply,
    ticketInactivityEnabled,
    ticketInactivityHours,
    ticketInactivityMessage,
    ticketSatisfactionCommentEnabled,
    ticketSatisfactionCommentQuestion,
    ticketSatisfactionCommentTimeout,
    ticketSatisfactionLogChannelId,
    ticketSatisfactionLogAnonymous,
    ticketLockUntilClaim,
    ticketApprovalEnabled,
    ticketApprovalChannelId,
    ticketArchiveCategoryId,
    ticketArchiveKeepOpenerView,
    ticketHistoryPanelEnabled,
    ticketSelfReopenEnabled,
    ticketSelfDeleteEnabled,
    ticketQuotaOpenEnabled,
    ticketQuotaOpenMax,
    ticketQuotaCooldownEnabled,
    ticketQuotaCooldownMinutes,
    ticketQuotaPeriodEnabled,
    ticketQuotaPeriodMax,
    ticketQuotaPeriodHours,
    ticketQuotaStaffLoadMode,
    ticketQuotaStaffLoadMax,
    ticketQuotaStaffLoadBypassRoleIds,
    ticketQuotaReopenEnabled,
    ticketQuotaReopenMax,
    ticketTypes,
    ticketEmbedThumbnail,
    ticketEmbedImage,
    ticketEmbedFooter,
    ticketEmbedAuthorName,
    ticketEmbedAuthorIcon,
    ticketWelcomeTitle,
    ticketWelcomeDesc,
    ticketWelcomeColor,
    ticketWelcomeThumbnail,
    ticketWelcomeImage,
    ticketWelcomeFooter
  });

  useUnsavedChanges({
    id: 'tickets',
    label: m.e1_tickets_config_label(),
    getConfig: () => currentSettings,
    getSaved: () => savedSettingsConfig,
    onSave: () => saveSettings(),
    onReset: () => restoreSettingsConfig(),
    canEdit: () => activeTab === 'config' && savedSettingsConfig !== null
  });

  function restoreSettingsConfig() {
    if (!savedSettingsConfig) return;
    ticketCategoryId = savedSettingsConfig.ticketCategoryId;
    ticketLogChannelId = savedSettingsConfig.ticketLogChannelId;
    ticketStaffRoleId = savedSettingsConfig.ticketStaffRoleId;
    ticketChannelId = savedSettingsConfig.ticketChannelId;
    ticketEmbedTitle = savedSettingsConfig.ticketEmbedTitle;
    ticketEmbedDesc = savedSettingsConfig.ticketEmbedDesc;
    ticketEmbedButtonText = savedSettingsConfig.ticketEmbedButtonText;
    ticketEmbedColor = savedSettingsConfig.ticketEmbedColor;
    ticketEmbedType = savedSettingsConfig.ticketEmbedType;
    ticketMode = savedSettingsConfig.ticketMode;
    ticketDmRelayChannelId = savedSettingsConfig.ticketDmRelayChannelId;
    ticketAllowOverclaim = savedSettingsConfig.ticketAllowOverclaim;
    ticketOverclaimPermission = savedSettingsConfig.ticketOverclaimPermission;
    ticketAutoClaimOnReply = savedSettingsConfig.ticketAutoClaimOnReply;
    ticketInactivityEnabled = savedSettingsConfig.ticketInactivityEnabled;
    ticketInactivityHours = savedSettingsConfig.ticketInactivityHours;
    ticketInactivityMessage = savedSettingsConfig.ticketInactivityMessage;
    ticketSatisfactionCommentEnabled = savedSettingsConfig.ticketSatisfactionCommentEnabled;
    ticketSatisfactionCommentQuestion = savedSettingsConfig.ticketSatisfactionCommentQuestion;
    ticketSatisfactionCommentTimeout = savedSettingsConfig.ticketSatisfactionCommentTimeout;
    ticketSatisfactionLogChannelId = savedSettingsConfig.ticketSatisfactionLogChannelId;
    ticketSatisfactionLogAnonymous = savedSettingsConfig.ticketSatisfactionLogAnonymous;
    ticketLockUntilClaim = savedSettingsConfig.ticketLockUntilClaim;
    ticketApprovalEnabled = savedSettingsConfig.ticketApprovalEnabled;
    ticketApprovalChannelId = savedSettingsConfig.ticketApprovalChannelId;
    ticketArchiveCategoryId = savedSettingsConfig.ticketArchiveCategoryId;
    ticketArchiveKeepOpenerView = savedSettingsConfig.ticketArchiveKeepOpenerView;
    ticketHistoryPanelEnabled = savedSettingsConfig.ticketHistoryPanelEnabled;
    ticketSelfReopenEnabled = savedSettingsConfig.ticketSelfReopenEnabled;
    ticketSelfDeleteEnabled = savedSettingsConfig.ticketSelfDeleteEnabled;
    ticketQuotaOpenEnabled = savedSettingsConfig.ticketQuotaOpenEnabled;
    ticketQuotaOpenMax = savedSettingsConfig.ticketQuotaOpenMax;
    ticketQuotaCooldownEnabled = savedSettingsConfig.ticketQuotaCooldownEnabled;
    ticketQuotaCooldownMinutes = savedSettingsConfig.ticketQuotaCooldownMinutes;
    ticketQuotaPeriodEnabled = savedSettingsConfig.ticketQuotaPeriodEnabled;
    ticketQuotaPeriodMax = savedSettingsConfig.ticketQuotaPeriodMax;
    ticketQuotaPeriodHours = savedSettingsConfig.ticketQuotaPeriodHours;
    ticketQuotaStaffLoadMode = savedSettingsConfig.ticketQuotaStaffLoadMode;
    ticketQuotaStaffLoadMax = savedSettingsConfig.ticketQuotaStaffLoadMax;
    ticketQuotaStaffLoadBypassRoleIds = savedSettingsConfig.ticketQuotaStaffLoadBypassRoleIds;
    ticketQuotaReopenEnabled = savedSettingsConfig.ticketQuotaReopenEnabled;
    ticketQuotaReopenMax = savedSettingsConfig.ticketQuotaReopenMax;
    ticketTypes = JSON.parse(JSON.stringify(savedSettingsConfig.ticketTypes));
    ticketEmbedThumbnail = savedSettingsConfig.ticketEmbedThumbnail;
    ticketEmbedImage = savedSettingsConfig.ticketEmbedImage;
    ticketEmbedFooter = savedSettingsConfig.ticketEmbedFooter;
    ticketEmbedAuthorName = savedSettingsConfig.ticketEmbedAuthorName;
    ticketEmbedAuthorIcon = savedSettingsConfig.ticketEmbedAuthorIcon;
    ticketWelcomeTitle = savedSettingsConfig.ticketWelcomeTitle;
    ticketWelcomeDesc = savedSettingsConfig.ticketWelcomeDesc;
    ticketWelcomeColor = savedSettingsConfig.ticketWelcomeColor;
    ticketWelcomeThumbnail = savedSettingsConfig.ticketWelcomeThumbnail;
    ticketWelcomeImage = savedSettingsConfig.ticketWelcomeImage;
    ticketWelcomeFooter = savedSettingsConfig.ticketWelcomeFooter;
  }

  async function changeTab(tab: 'tickets' | 'transcripts' | 'satisfaction' | 'blacklist' | 'config') {
    if (unsavedChanges.isDirty && unsavedChanges.ownerId === 'tickets') {
      const confirmLeave = await confirmDialog.ask({
        title: m.e1_tickets_unsaved_title(),
        description: m.e1_tickets_unsaved_desc(),
        confirmLabel: m.e1_tickets_unsaved_confirm(),
        variant: 'warning',
      });
      if (!confirmLeave) return;
      unsavedChanges.clear();
      restoreSettingsConfig();
    }
    gotoTab('/tickets', tab, DEFAULT_TICKETS_TAB);
  }

  // Derived values from Dashboard Store
  const discordChannels = $derived(dashboardStore.state.discordChannels || []);
  const discordCategories = $derived(dashboardStore.state.discordCategories || []);
  const discordRoles = $derived(dashboardStore.state.discordRoles || []);

  // ── Macros ────────────────────────────────────────────────────────────────
  type TicketMacro = {
    id: string;
    name: string;
    category: string | null;
    emoji: string | null;
    content: string;
    enabled: boolean;
    position: number;
    ticketTypeIds: string[];
    allowedRoleIds: string[];
    keywords: string[];
    autoSendOnOpen: boolean;
    setTicketTypeId: string | null;
    addRoleId: string | null;
    removeRoleId: string | null;
    requestSatisfaction: boolean;
    closeTicket: boolean;
    usageCount: number;
  };

  let macros = $state<TicketMacro[]>([]);
  let macrosLoading = $state(false);
  let macroModalOpen = $state(false);
  let macroSaving = $state(false);
  /** `null` = creation ; sinon l'identifiant de la macro modifiee. */
  let editingMacroId = $state<string | null>(null);
  let macroForm = $state(emptyMacroForm());
  /** Saisie libre des mots-cles, convertie en tableau a l'enregistrement. */
  let macroKeywordsText = $state('');

  function emptyMacroForm() {
    return {
      name: '',
      category: '',
      emoji: '',
      content: '',
      enabled: true,
      position: 0,
      ticketTypeIds: [] as string[],
      allowedRoleIds: [] as string[],
      autoSendOnOpen: false,
      setTicketTypeId: '',
      addRoleId: '',
      removeRoleId: '',
      requestSatisfaction: false,
      closeTicket: false,
    };
  }

  /** Resume des actions attachees, pour la ligne de la liste. */
  function macroActionSummary(macro: TicketMacro): string {
    const parts: string[] = [];
    if (macro.setTicketTypeId) parts.push('requalifie');
    if (macro.addRoleId) parts.push('pose un rôle');
    if (macro.removeRoleId) parts.push('retire un rôle');
    if (macro.requestSatisfaction) parts.push('sonde');
    if (macro.closeTicket) parts.push('ferme');
    return parts.join(', ');
  }

  async function loadMacros() {
    if (!authStore.selectedGuildId) return;
    macrosLoading = true;
    try {
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/tickets/macros`, {
        headers: { Authorization: `Bearer ${authStore.token}` },
      });
      if (!res.ok) throw new Error('Chargement des macros impossible');
      macros = (await res.json()).macros || [];
    } catch (err: any) {
      toast.error(err.message || 'Chargement des macros impossible');
    } finally {
      macrosLoading = false;
    }
  }

  function openNewMacro() {
    editingMacroId = null;
    macroForm = emptyMacroForm();
    macroKeywordsText = '';
    macroModalOpen = true;
  }

  function openEditMacro(macro: TicketMacro) {
    editingMacroId = macro.id;
    macroForm = {
      name: macro.name,
      category: macro.category || '',
      emoji: macro.emoji || '',
      content: macro.content,
      enabled: macro.enabled,
      position: macro.position,
      ticketTypeIds: [...(macro.ticketTypeIds || [])],
      allowedRoleIds: [...(macro.allowedRoleIds || [])],
      autoSendOnOpen: macro.autoSendOnOpen,
      setTicketTypeId: macro.setTicketTypeId || '',
      addRoleId: macro.addRoleId || '',
      removeRoleId: macro.removeRoleId || '',
      requestSatisfaction: macro.requestSatisfaction,
      closeTicket: macro.closeTicket,
    };
    macroKeywordsText = (macro.keywords || []).join(', ');
    macroModalOpen = true;
  }

  async function saveMacro() {
    if (!authStore.selectedGuildId || macroSaving) return;
    if (!macroForm.name.trim() || !macroForm.content.trim()) {
      toast.error('Le nom et le contenu sont obligatoires.');
      return;
    }

    macroSaving = true;
    try {
      const base = `${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/tickets/macros`;
      const res = await fetch(editingMacroId ? `${base}/${editingMacroId}` : base, {
        method: editingMacroId ? 'PATCH' : 'POST',
        headers: { Authorization: `Bearer ${authStore.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...macroForm,
          keywords: macroKeywordsText.split(',').map((k) => k.trim()).filter(Boolean),
          // Chaines vides = « pas d'action », que l'API attend en `null`.
          setTicketTypeId: macroForm.setTicketTypeId || null,
          addRoleId: macroForm.addRoleId || null,
          removeRoleId: macroForm.removeRoleId || null,
          category: macroForm.category || null,
          emoji: macroForm.emoji || null,
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Enregistrement impossible');

      toast.success(editingMacroId ? 'Macro mise à jour' : 'Macro créée');
      macroModalOpen = false;
      await loadMacros();
    } catch (err: any) {
      toast.error(err.message || 'Enregistrement impossible');
    } finally {
      macroSaving = false;
    }
  }

  async function deleteMacro(macro: TicketMacro) {
    const confirmed = await confirmDialog.ask({
      title: 'Supprimer cette macro ?',
      description: `« ${macro.name} » sera définitivement retirée du sélecteur du staff.`,
      confirmLabel: 'Supprimer',
      variant: 'danger',
    });
    if (!confirmed) return;

    try {
      const res = await fetch(
        `${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/tickets/macros/${macro.id}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${authStore.token}` } },
      );
      if (!res.ok) throw new Error('Suppression impossible');
      toast.success('Macro supprimée');
      await loadMacros();
    } catch (err: any) {
      toast.error(err.message || 'Suppression impossible');
    }
  }

  /**
   * Les seuls reglages qui empechent un ticket d'exister. Tout le reste de la
   * page en affine le comportement : les melanger ferait passer pour egales
   * une categorie manquante et une couleur d'embed non choisie.
   */
  const configBlockers = $derived(
    [
      { key: 'category', label: 'la catégorie', ok: !!ticketCategoryId },
      { key: 'staffRole', label: 'le rôle du staff', ok: !!ticketStaffRoleId },
      { key: 'panelChannel', label: 'le salon du panneau', ok: !!ticketChannelId },
    ].filter((item) => !item.ok)
  );

  const STAFF_LOAD_MODES = [
    { value: 'OFF', label: 'Désactivé' },
    { value: 'WARN', label: 'Avertir' },
    { value: 'BLOCK', label: 'Bloquer' },
  ] as const;

  /** Badge de l'accordeon : combien de quotas imposent effectivement une limite. */
  const activeQuotaCount = $derived(
    [
      ticketQuotaOpenEnabled,
      ticketQuotaCooldownEnabled,
      ticketQuotaPeriodEnabled,
      ticketQuotaStaffLoadMode !== 'OFF',
      ticketQuotaReopenEnabled,
    ].filter(Boolean).length
  );


  const saveAction = createAsyncActionState();
  const sendEmbedAction = createAsyncActionState();
  const setupAction = createAsyncActionState();
  const renameAction = createAsyncActionState();

  /**
   * Les réglages « verrouillage » et « validation » d'un type de ticket sont
   * tri-états côté bot (`true` / `false` / `null` = suivre le serveur). Un
   * `<select>` ne manipulant que des chaînes, la conversion se fait ici, dans
   * les deux sens, plutôt que d'éparpiller des ternaires dans le balisage.
   */
  function inheritedToSelect(value: unknown): '' | 'YES' | 'NO' {
    if (value === true) return 'YES';
    if (value === false) return 'NO';
    return '';
  }

  function selectToInherited(value: '' | 'YES' | 'NO'): boolean | null {
    if (value === 'YES') return true;
    if (value === 'NO') return false;
    return null;
  }

  /** Choix d'une question : le texte saisi reste la source de vérité. */
  function parseChoices(raw: string | undefined): string[] {
    return (raw ?? '')
      .split(',')
      .map((choice) => choice.trim())
      .filter(Boolean);
  }

  /**
   * Types de tickets prêts pour l'API : tri-états reconvertis en booléens et
   * questions nettoyées. `choicesString` n'existe que pour l'édition, on ne
   * l'envoie pas ; les choix sont recalculés depuis lui au moment de sauver
   * pour qu'un collage ou une correction ne soit jamais perdu.
   */
  function serializeTicketTypes() {
    return ticketTypes.map((type) => ({
      ...type,
      lockUntilClaim: selectToInherited(type.lockUntilClaim),
      requireApproval: selectToInherited(type.requireApproval),
      formCustomFields: (type.formCustomFields || []).map((field) => ({
        id: field.id,
        label: (field.label || '').trim(),
        placeholder: (field.placeholder || '').trim(),
        style: field.style,
        required: field.required !== false,
        choices: field.style === 'SELECT' || field.style === 'RADIO' ? parseChoices(field.choicesString) : [],
      })),
    }));
  }

  /** Une question sans intitulé est refusée par Discord : on bloque avant l'envoi. */
  function findInvalidQuestion(): { typeLabel: string; index: number } | null {
    for (const type of ticketTypes) {
      if (!type.formEnabled) continue;
      const fields = type.formCustomFields || [];
      for (let index = 0; index < fields.length; index++) {
        if (!(fields[index].label || '').trim()) {
          return { typeLabel: type.label || '', index: index + 1 };
        }
      }
    }
    return null;
  }

  function createTicketTypeDraft(index = 0, legacy?: any) {
    return {
      id: legacy?.ticketTypeId || crypto.randomUUID(),
      label: legacy?.ticketEmbedButtonText || m.e1_tickets_default_ticket_label({ index: index + 1 }),
      description: legacy?.ticketEmbedDesc || '',
      emoji: '📩',
      categoryId: legacy?.ticketCategoryId || ticketCategoryId || '',
      staffRoleId: legacy?.ticketStaffRoleId || ticketStaffRoleId || '',
      buttonStyle: 'PRIMARY' as const,
      mode: '' as '' | 'CHANNEL' | 'DM' | 'THREAD',
      anonymous: false,
      staffServerRelay: false,
      staffServerChannel: false,
      staffServerCategoryId: '',
      lockUntilClaim: '' as '' | 'YES' | 'NO',
      requireApproval: '' as '' | 'YES' | 'NO',
      formEnabled: true,
      formCustomFields: [] as Array<{
        id: string;
        label: string;
        placeholder: string;
        style: 'SHORT' | 'PARAGRAPH' | 'SELECT' | 'RADIO' | 'FILE';
        required: boolean;
        choices?: string[];
        choicesString?: string;
      }>
    };
  }

  function normalizeTicketTypes(config: any): Array<{
    id: string;
    label: string;
    description: string;
    emoji: string;
    categoryId: string;
    staffRoleId: string;
    buttonStyle: 'PRIMARY' | 'SECONDARY' | 'SUCCESS' | 'DANGER';
    mode: '' | 'CHANNEL' | 'DM' | 'THREAD';
    anonymous: boolean;
    staffServerRelay: boolean;
    staffServerChannel: boolean;
    staffServerCategoryId: string;
    /** Tri-etat : '' herite du serveur, 'YES'/'NO' tranchent pour ce type. */
    lockUntilClaim: '' | 'YES' | 'NO';
    requireApproval: '' | 'YES' | 'NO';
    formEnabled: boolean;
    formCustomFields: Array<{
      id: string;
      label: string;
      placeholder: string;
      style: 'SHORT' | 'PARAGRAPH' | 'SELECT' | 'RADIO' | 'FILE';
      required: boolean;
      choices?: string[];
      choicesString?: string;
    }>;
  }> {
    if (Array.isArray(config?.ticketTypes) && config.ticketTypes.length > 0) {
      return config.ticketTypes
        .filter((item: any) => item && typeof item === 'object')
        .map((item: any, index: number) => ({
          id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : crypto.randomUUID(),
          label: typeof item.label === 'string' && item.label.trim() ? item.label.trim().slice(0, 80) : m.e1_tickets_default_ticket_label({ index: index + 1 }),
          description: typeof item.description === 'string' ? item.description.trim().slice(0, 200) : '',
          emoji: typeof item.emoji === 'string' && item.emoji.trim() ? item.emoji.trim().slice(0, 16) : '📩',
          categoryId: typeof item.categoryId === 'string' ? item.categoryId : '',
          staffRoleId: typeof item.staffRoleId === 'string' ? item.staffRoleId : '',
          buttonStyle: item.buttonStyle === 'SECONDARY' || item.buttonStyle === 'SUCCESS' || item.buttonStyle === 'DANGER'
            ? item.buttonStyle
            : 'PRIMARY',
          mode: item.mode === 'CHANNEL' || item.mode === 'DM' || item.mode === 'THREAD' ? item.mode : '',
          anonymous: item.anonymous === true,
          staffServerRelay: item.staffServerRelay === true,
          staffServerChannel: item.staffServerChannel === true,
          staffServerCategoryId: typeof item.staffServerCategoryId === 'string' ? item.staffServerCategoryId : '',
          lockUntilClaim: inheritedToSelect(item.lockUntilClaim),
          requireApproval: inheritedToSelect(item.requireApproval),
          formEnabled: item.formEnabled !== undefined ? item.formEnabled : true,
          formCustomFields: Array.isArray(item.formCustomFields)
            ? item.formCustomFields.map((f: any, fieldIndex: number) => ({
                // Un identifiant vide ferait doublon dans le modal Discord,
                // qui refuse alors le formulaire entier.
                id: typeof f.id === 'string' && f.id.trim() ? f.id.trim() : `field_${index + 1}_${fieldIndex + 1}`,
                label: f.label || '',
                placeholder: f.placeholder || '',
                style: f.style || 'SHORT',
                required: f.required !== false,
                choices: Array.isArray(f.choices) ? f.choices : [],
                choicesString: Array.isArray(f.choices) ? f.choices.join(', ') : '',
              }))
            : [],
        }));
    }

      return [createTicketTypeDraft(0, config)];
  }

  function addCustomField(typeIndex: number) {
    const ticketType = ticketTypes[typeIndex];
    if (!ticketType.formCustomFields) {
      ticketType.formCustomFields = [];
    }
    if (ticketType.formCustomFields.length >= 5) {
      toast.error(m.e1_tickets_err_max_fields());
      return;
    }
    const newId = 'field_' + Math.random().toString(36).substring(2, 10);
    ticketType.formCustomFields = [...ticketType.formCustomFields, {
      id: newId,
      label: m.e1_tickets_default_question_label({ index: ticketType.formCustomFields.length + 1 }),
      placeholder: '',
      style: 'SHORT',
      required: true,
      // Ces deux champs doivent exister des la creation : `bind:value` sur une
      // valeur `undefined` fait planter la page des qu'on choisit un type a choix.
      choices: [],
      choicesString: ''
    }];
  }

  function removeCustomField(typeIndex: number, fieldId: string) {
    const ticketType = ticketTypes[typeIndex];
    ticketType.formCustomFields = ticketType.formCustomFields.filter(f => f.id !== fieldId);
  }

  function addTicketType() {
    ticketTypes = [...ticketTypes, createTicketTypeDraft(ticketTypes.length)];
    expandedTicketTypeIndex = ticketTypes.length - 1; // Expands the newly created ticket type
  }

  function removeTicketType(index: number) {
    ticketTypes = ticketTypes.filter((_, currentIndex) => currentIndex !== index);
    if (expandedTicketTypeIndex === index) {
      expandedTicketTypeIndex = null;
    } else if (expandedTicketTypeIndex !== null && expandedTicketTypeIndex > index) {
      expandedTicketTypeIndex--;
    }
    if (ticketTypes.length === 0) {
      ticketTypes = [createTicketTypeDraft(0)];
      expandedTicketTypeIndex = 0;
    }
  }

  function moveTicketType(index: number, direction: 'UP' | 'DOWN') {
    if (direction === 'UP' && index > 0) {
      const temp = ticketTypes[index];
      ticketTypes[index] = ticketTypes[index - 1];
      ticketTypes[index - 1] = temp;
      ticketTypes = [...ticketTypes];
      if (expandedTicketTypeIndex === index) {
        expandedTicketTypeIndex = index - 1;
      } else if (expandedTicketTypeIndex === index - 1) {
        expandedTicketTypeIndex = index;
      }
    } else if (direction === 'DOWN' && index < ticketTypes.length - 1) {
      const temp = ticketTypes[index];
      ticketTypes[index] = ticketTypes[index + 1];
      ticketTypes[index + 1] = temp;
      ticketTypes = [...ticketTypes];
      if (expandedTicketTypeIndex === index) {
        expandedTicketTypeIndex = index + 1;
      } else if (expandedTicketTypeIndex === index + 1) {
        expandedTicketTypeIndex = index;
      }
    }
  }

  // Filters tickets based on status tab
  const filteredTickets = $derived(
    tickets.filter(t => {
      if (ticketFilter === 'ALL') return true;
      return t.status === ticketFilter;
    })
  );

  // Fetch all tickets and config
  async function loadTicketsAndConfig(reset = true) {
    if (!authStore.selectedGuildId) return;
    if (reset) {
      loading = true;
      ticketsOffset = 0;
    } else {
      loadingMoreTickets = true;
    }
    error = '';
    try {
      const params = new URLSearchParams({
        limit: String(TICKETS_PAGE_SIZE),
        offset: String(reset ? 0 : ticketsOffset),
      });
      if (ticketFilter !== 'ALL') params.set('status', ticketFilter);

      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/tickets?${params}`, {
        headers: { 'Authorization': `Bearer ${authStore.token}` }
      });
      if (!res.ok) throw new Error(m.e1_tickets_err_load_system());
      const data = await res.json();
      const incomingTickets = data.tickets || [];
      tickets = reset ? incomingTickets : [...tickets, ...incomingTickets];
      ticketsHasMore = data.pagination?.hasMore === true;
      ticketsOffset = data.pagination?.nextOffset ?? ticketsOffset;
      config = data.config || {};
      
      // Populate config bindings
      ticketCategoryId = config.ticketCategoryId || '';
      ticketLogChannelId = config.ticketLogChannelId || '';
      ticketStaffRoleId = config.ticketStaffRoleId || '';
      ticketChannelId = config.ticketChannelId || '';
      // Laisses vides quand ils le sont : le bot compose alors le texte par
      // defaut dans la langue du serveur. Les remplir ici reviendrait a figer
      // en base la langue du dashboard de celui qui enregistre. Le champ
      // montre le defaut en filigrane.
      ticketEmbedTitle = config.ticketEmbedTitle || '';
      ticketEmbedDesc = config.ticketEmbedDesc || '';
      ticketEmbedButtonText = config.ticketEmbedButtonText || '';
      ticketEmbedColor = config.ticketEmbedColor || '#5865F2';
      ticketEmbedType = config.ticketEmbedType === 'DROPDOWN' ? 'DROPDOWN' : 'BUTTONS';
      ticketMode = config.ticketMode || 'CHANNEL';
      ticketDmRelayChannelId = config.ticketDmRelayChannelId || '';
      ticketAllowOverclaim = config.ticketAllowOverclaim !== undefined ? config.ticketAllowOverclaim : true;
      ticketOverclaimPermission = config.ticketOverclaimPermission || 'ANY';
      ticketAutoClaimOnReply = config.ticketAutoClaimOnReply === true;
      ticketInactivityEnabled = config.ticketInactivityEnabled !== undefined ? config.ticketInactivityEnabled : false;
      ticketInactivityHours = config.ticketInactivityHours !== undefined ? config.ticketInactivityHours : 24;
      ticketInactivityMessage = config.ticketInactivityMessage || '';
      ticketSatisfactionCommentEnabled = config.ticketSatisfactionCommentEnabled !== undefined ? config.ticketSatisfactionCommentEnabled : true;
      // Laisse vide : le bot pose alors sa question par defaut, comme pour les embeds.
      ticketSatisfactionCommentQuestion = config.ticketSatisfactionCommentQuestion || '';
      ticketSatisfactionCommentTimeout = config.ticketSatisfactionCommentTimeout !== undefined ? config.ticketSatisfactionCommentTimeout : 120;
      ticketSatisfactionLogChannelId = config.ticketSatisfactionLogChannelId || '';
      ticketSatisfactionLogAnonymous = config.ticketSatisfactionLogAnonymous === true;
      ticketLockUntilClaim = config.ticketLockUntilClaim === true;
      ticketApprovalEnabled = config.ticketApprovalEnabled === true;
      ticketApprovalChannelId = config.ticketApprovalChannelId || '';
      ticketArchiveCategoryId = config.ticketArchiveCategoryId || '';
      ticketArchiveKeepOpenerView = config.ticketArchiveKeepOpenerView === true;
      // Actifs par defaut cote serveur : `!== false` pour qu'une config lue
      // avant migration ne les affiche pas eteints.
      ticketHistoryPanelEnabled = config.ticketHistoryPanelEnabled !== false;
      ticketSelfReopenEnabled = config.ticketSelfReopenEnabled !== false;
      ticketSelfDeleteEnabled = config.ticketSelfDeleteEnabled === true;
      ticketQuotaOpenEnabled = config.ticketQuotaOpenEnabled === true;
      ticketQuotaOpenMax = config.ticketQuotaOpenMax ?? 1;
      ticketQuotaCooldownEnabled = config.ticketQuotaCooldownEnabled === true;
      ticketQuotaCooldownMinutes = config.ticketQuotaCooldownMinutes ?? 30;
      ticketQuotaPeriodEnabled = config.ticketQuotaPeriodEnabled === true;
      ticketQuotaPeriodMax = config.ticketQuotaPeriodMax ?? 5;
      ticketQuotaPeriodHours = config.ticketQuotaPeriodHours ?? 24;
      ticketQuotaStaffLoadMode = config.ticketQuotaStaffLoadMode || 'OFF';
      ticketQuotaStaffLoadMax = config.ticketQuotaStaffLoadMax ?? 5;
      ticketQuotaStaffLoadBypassRoleIds = config.ticketQuotaStaffLoadBypassRoleIds || [];
      ticketQuotaReopenEnabled = config.ticketQuotaReopenEnabled === true;
      ticketQuotaReopenMax = config.ticketQuotaReopenMax ?? 3;
      ticketTypes = normalizeTicketTypes(config);
      ticketEmbedThumbnail = config.ticketEmbedThumbnail || '';
      ticketEmbedImage = config.ticketEmbedImage || '';
      ticketEmbedFooter = config.ticketEmbedFooter || '';
      ticketEmbedAuthorName = config.ticketEmbedAuthorName || '';
      ticketEmbedAuthorIcon = config.ticketEmbedAuthorIcon || '';
      ticketWelcomeTitle = config.ticketWelcomeTitle || '';
      ticketWelcomeDesc = config.ticketWelcomeDesc || '';
      ticketWelcomeColor = config.ticketWelcomeColor || '#5865F2';
      ticketWelcomeThumbnail = config.ticketWelcomeThumbnail || '';
      ticketWelcomeImage = config.ticketWelcomeImage || '';
      ticketWelcomeFooter = config.ticketWelcomeFooter || '';
      savedSettingsConfig = {
        ticketCategoryId,
        ticketLogChannelId,
        ticketStaffRoleId,
        ticketChannelId,
        ticketEmbedTitle,
        ticketEmbedDesc,
        ticketEmbedButtonText,
        ticketEmbedColor,
        ticketEmbedType,
        ticketMode,
        ticketDmRelayChannelId,
        ticketAllowOverclaim,
        ticketOverclaimPermission,
        ticketAutoClaimOnReply,
        ticketInactivityEnabled,
        ticketInactivityHours,
        ticketInactivityMessage,
        ticketSatisfactionCommentEnabled,
        ticketSatisfactionCommentQuestion,
        ticketSatisfactionCommentTimeout,
        ticketSatisfactionLogChannelId,
        ticketSatisfactionLogAnonymous,
        ticketLockUntilClaim,
        ticketApprovalEnabled,
        ticketApprovalChannelId,
        ticketArchiveCategoryId,
        ticketArchiveKeepOpenerView,
        ticketHistoryPanelEnabled,
        ticketSelfReopenEnabled,
        ticketSelfDeleteEnabled,
        ticketQuotaOpenEnabled,
        ticketQuotaOpenMax,
        ticketQuotaCooldownEnabled,
        ticketQuotaCooldownMinutes,
        ticketQuotaPeriodEnabled,
        ticketQuotaPeriodMax,
        ticketQuotaPeriodHours,
        ticketQuotaStaffLoadMode,
        ticketQuotaStaffLoadMax,
        ticketQuotaStaffLoadBypassRoleIds,
        ticketQuotaReopenEnabled,
        ticketQuotaReopenMax,
        ticketTypes: JSON.parse(JSON.stringify(ticketTypes)),
        ticketEmbedThumbnail,
        ticketEmbedImage,
        ticketEmbedFooter,
        ticketEmbedAuthorName,
        ticketEmbedAuthorIcon,
        ticketWelcomeTitle,
        ticketWelcomeDesc,
        ticketWelcomeColor,
        ticketWelcomeThumbnail,
        ticketWelcomeImage,
        ticketWelcomeFooter
      };
    } catch (err: any) {
      error = err.message || 'Une erreur est survenue';
    } finally {
      loading = false;
      loadingMoreTickets = false;
    }
  }

  async function refreshTicketsOnly() {
    if (!authStore.selectedGuildId || !authStore.token) return;
    try {
      const params = new URLSearchParams({
        limit: String(Math.max(TICKETS_PAGE_SIZE, tickets.length || TICKETS_PAGE_SIZE)),
        offset: '0',
      });
      if (ticketFilter !== 'ALL') params.set('status', ticketFilter);

      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/tickets?${params}`, {
        headers: { 'Authorization': `Bearer ${authStore.token}` }
      });
      if (!res.ok) return;
      const data = await res.json();
      tickets = data.tickets || [];
      ticketsHasMore = data.pagination?.hasMore === true;
      ticketsOffset = data.pagination?.nextOffset ?? tickets.length;

      if (selectedTicketId) {
        const found = tickets.find((t) => t.id === selectedTicketId);
        if (found && selectedTicketDetail) {
          selectedTicketDetail = { ...selectedTicketDetail, ...found };
        }
      }
    } catch {
      // Échec silencieux pour un rafraîchissement d'arrière-plan
    }
  }

  function changeTicketFilter(filter: TicketFilter) {
    if (ticketFilter === filter) return;
    ticketFilter = filter;
    selectedTicketId = null;
    selectedTicketDetail = null;
    messages = [];
    void loadTicketsAndConfig(true);
  }

  // Fetch transcripts for this guild
  async function loadTranscripts() {
    if (!authStore.selectedGuildId) return;
    loading = true;
    error = '';
    try {
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/tickets/transcripts?includeTotal=false`, {
        headers: { 'Authorization': `Bearer ${authStore.token}` }
      });
      if (!res.ok) throw new Error(m.e1_tickets_err_load_transcripts());
      const data = await res.json();
      transcripts = data.transcripts || [];
    } catch (err: any) {
      error = err.message || 'Une erreur est survenue';
    } finally {
      loading = false;
    }
  }

  async function handleRefresh() {
    if (activeTab === 'transcripts') {
      await loadTranscripts();
    } else if (activeTab === 'satisfaction') {
      await loadSatisfaction();
    } else if (activeTab === 'blacklist') {
      await loadBlacklist();
    } else if (activeTab === 'macros') {
      await loadMacros();
    } else {
      await loadTicketsAndConfig();
    }
  }

  // Fetch details & messages for selected ticket
  async function loadTicketDetail(ticketId: string, autoScroll = true) {
    if (!authStore.selectedGuildId) return;
    loadingDetail = true;
    try {
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/tickets/${ticketId}`, {
        headers: { 'Authorization': `Bearer ${authStore.token}` }
      });
      if (!res.ok) throw new Error(m.e1_tickets_err_load_detail());
      const data = await res.json();
      selectedTicketDetail = data.ticket;
      messages = data.messages || [];
      ticketRenameName = data.ticket?.channelName || '';

      signedTranscriptUrl = null;
      if (data.ticket?.transcriptId && messages.length === 0) {
        try {
          const signRes = await fetch(
            `${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/tickets/transcripts/${data.ticket.transcriptId}/signed-url`,
            { headers: { Authorization: `Bearer ${authStore.token}` } },
          );
          if (signRes.ok) {
            const signData = await signRes.json();
            signedTranscriptUrl = `${API_BASE_URL}${signData.signedUrl}`;
          }
        } catch {}
      }

      if (autoScroll) {
        setTimeout(scrollToBottom, 50);
      }
    } catch (err: any) {
      console.error(err);
    } finally {
      loadingDetail = false;
    }
  }

  function selectTicket(ticketId: string) {
    selectedTicketId = ticketId;
    void loadTicketDetail(ticketId, true);
  }

  // Scroll chat window to bottom
  function scrollToBottom() {
    if (chatScrollContainer) {
      chatScrollContainer.scrollTop = chatScrollContainer.scrollHeight;
    }
  }

  // Send message from Svelte Panel to Discord
  async function sendMessage() {
    if (!chatInput.trim() || !selectedTicketId || !authStore.selectedGuildId) return;
    const textToSend = chatInput;
    chatInput = '';
    
    // Add locally immediately with a temp ID for high responsiveness
    const tempMsg = {
      id: `temp-${Date.now()}`,
      content: textToSend,
      authorName: authStore.user?.username || 'Staff',
      authorAvatar: authStore.user?.avatarUrl || '',
      isStaff: true,
      createdAt: new Date().toISOString()
    };
    messages = [...messages, tempMsg];
    setTimeout(scrollToBottom, 30);

    try {
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/tickets/${selectedTicketId}/message`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authStore.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ content: textToSend })
      });
      if (!res.ok) throw new Error(m.e1_tickets_err_send_message());
      // Reload actual messages
      await loadTicketDetail(selectedTicketId, false);
    } catch (err: any) {
      toast.error(err.message || m.e1_tickets_err_generic());
    }
  }

  // Claim Ticket
  async function claimTicket() {
    if (!selectedTicketId || !authStore.selectedGuildId) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/tickets/${selectedTicketId}/claim`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authStore.token}` }
      });
      if (!res.ok) throw new Error(m.e1_tickets_err_claim());
      await loadTicketDetail(selectedTicketId, false);
      await loadTicketsAndConfig();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  // Close Ticket
  async function closeTicket() {
    if (!selectedTicketId || !authStore.selectedGuildId) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/tickets/${selectedTicketId}/close`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authStore.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ reason: closeReason })
      });
      if (!res.ok) throw new Error(m.e1_tickets_err_close());
      showCloseModal = false;
      closeReason = '';
      await loadTicketDetail(selectedTicketId, false);
      await loadTicketsAndConfig();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  // Rename Ticket
  async function renameTicket() {
    if (!selectedTicketId || !authStore.selectedGuildId || !ticketRenameName.trim()) return;
    const ticketId = selectedTicketId;
    await renameAction.run(async () => {
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/tickets/${ticketId}/rename`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authStore.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: ticketRenameName.trim() })
      });
      if (!res.ok) throw new Error(m.e1_tickets_err_rename());
      const data = await res.json().catch(() => null);
      if (data?.channelName) {
        ticketRenameName = data.channelName;
      }
      await loadTicketDetail(ticketId, false);
      await loadTicketsAndConfig();
      return true;
    }, { successMessage: m.e1_tickets_renamed_toast() });
  }

  // Reopen Ticket
  async function reopenTicket() {
    if (!selectedTicketId || !authStore.selectedGuildId) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/tickets/${selectedTicketId}/reopen`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authStore.token}` }
      });
      if (!res.ok) throw new Error(m.e1_tickets_err_reopen());
      await loadTicketDetail(selectedTicketId, false);
      await loadTicketsAndConfig();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  // Restore Ticket
  let showRestoreModal = $state(false);
  let restoring = $state(false);

  async function restoreTicket() {
    if (!selectedTicketId || !authStore.selectedGuildId) return;
    restoring = true;
    try {
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/tickets/${selectedTicketId}/restore`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authStore.token}` }
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || m.e1_tickets_err_restore());
      }
      showRestoreModal = false;
      toast.success(m.e1_tickets_restored_toast());
      await loadTicketDetail(selectedTicketId, false);
      await loadTicketsAndConfig();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      restoring = false;
    }
  }

  // ─── Archivage et verrou anti-suppression ──────────────────────────────────

  /**
   * Le verrou peut porter une échéance : un ticket dont la date est passée n'est
   * plus protégé, même si le drapeau est resté à vrai en base. On le recalcule
   * ici plutôt que de se fier au seul booléen, comme le fait le bot.
   */
  const deletionLock = $derived.by(() => {
    const t = selectedTicketDetail;
    if (!t?.deletionLocked) return null;
    const until = t.deletionLockedUntil ? new Date(t.deletionLockedUntil) : null;
    if (until && until.getTime() <= Date.now()) return null;
    return { until, reason: t.deletionLockReason ?? null, byName: t.deletionLockedByName ?? null };
  });

  let showLockModal = $state(false);
  let lockDuration = $state<'7d' | '30d' | '90d' | 'permanent'>('30d');
  let lockReason = $state('');
  let lockBusy = $state(false);

  const LOCK_DURATION_MS: Record<string, number | null> = {
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
    '90d': 90 * 24 * 60 * 60 * 1000,
    permanent: null,
  };

  async function postTicketAction(action: string, body?: unknown): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/tickets/${selectedTicketId}/${action}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authStore.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || m.e1_tickets_action_failed());
    return data;
  }

  async function archiveTicket(unarchive = false) {
    if (!selectedTicketId || !authStore.selectedGuildId) return;
    try {
      await postTicketAction(unarchive ? 'unarchive' : 'archive');
      toast.success(unarchive ? m.e1_tickets_unarchived_toast() : m.e1_tickets_archived_toast());
      await loadTicketDetail(selectedTicketId, false);
      await loadTicketsAndConfig();
    } catch (err: any) {
      toast.error(err.message || m.e1_tickets_err_archive());
    }
  }

  async function lockTicket() {
    if (!selectedTicketId || !authStore.selectedGuildId) return;
    lockBusy = true;
    try {
      await postTicketAction('lock', {
        durationMs: LOCK_DURATION_MS[lockDuration],
        reason: lockReason.trim() || null,
      });
      showLockModal = false;
      lockReason = '';
      toast.success(m.e1_tickets_locked_toast());
      await loadTicketDetail(selectedTicketId, false);
      await loadTicketsAndConfig();
    } catch (err: any) {
      toast.error(err.message || m.e1_tickets_err_lock());
    } finally {
      lockBusy = false;
    }
  }

  async function unlockTicket() {
    if (!selectedTicketId || !authStore.selectedGuildId) return;
    try {
      await postTicketAction('unlock');
      toast.success(m.e1_tickets_unlocked_toast());
      await loadTicketDetail(selectedTicketId, false);
      await loadTicketsAndConfig();
    } catch (err: any) {
      toast.error(err.message || m.e1_tickets_err_lock());
    }
  }

  // Delete Ticket
  async function deleteTicket() {
    if (!selectedTicketId || !authStore.selectedGuildId) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/tickets/${selectedTicketId}/delete`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authStore.token}` }
      });
      if (!res.ok) throw new Error(m.e1_tickets_err_delete());
      showDeleteConfirmModal = false;
      selectedTicketId = null;
      selectedTicketDetail = null;
      signedTranscriptUrl = null;
      messages = [];
      await loadTicketsAndConfig();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  // Save Settings Config
  async function saveSettings(): Promise<boolean> {
    const invalidQuestion = findInvalidQuestion();
    if (invalidQuestion) {
      toast.error(m.e1_tickets_err_empty_question({ index: invalidQuestion.index, type: invalidQuestion.typeLabel }));
      return false;
    }
    let success = false;
    await saveAction.run(async () => {
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/tickets/config`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${authStore.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ticketCategoryId,
          ticketLogChannelId,
          ticketStaffRoleId,
          ticketChannelId,
          ticketEmbedTitle,
          ticketEmbedDesc,
          ticketEmbedButtonText,
          ticketEmbedColor,
          ticketEmbedType,
          ticketMode,
          ticketDmRelayChannelId,
          ticketLockUntilClaim,
          ticketApprovalEnabled,
          ticketApprovalChannelId,
          ticketArchiveCategoryId,
          ticketArchiveKeepOpenerView,
          ticketHistoryPanelEnabled,
          ticketSelfReopenEnabled,
          ticketSelfDeleteEnabled,
          ticketQuotaOpenEnabled,
          ticketQuotaOpenMax,
          ticketQuotaCooldownEnabled,
          ticketQuotaCooldownMinutes,
          ticketQuotaPeriodEnabled,
          ticketQuotaPeriodMax,
          ticketQuotaPeriodHours,
          ticketQuotaStaffLoadMode,
          ticketQuotaStaffLoadMax,
          ticketQuotaStaffLoadBypassRoleIds,
          ticketQuotaReopenEnabled,
          ticketQuotaReopenMax,
          ticketTypes: serializeTicketTypes(),
          ticketAllowOverclaim,
          ticketOverclaimPermission,
          ticketAutoClaimOnReply,
          ticketInactivityEnabled,
          ticketInactivityHours,
          ticketInactivityMessage,
          ticketSatisfactionCommentEnabled,
          ticketSatisfactionCommentQuestion,
          ticketSatisfactionCommentTimeout,
          ticketSatisfactionLogChannelId,
          ticketSatisfactionLogAnonymous,
          ticketEmbedThumbnail,
          ticketEmbedImage,
          ticketEmbedFooter,
          ticketEmbedAuthorName,
          ticketEmbedAuthorIcon,
          ticketWelcomeTitle,
          ticketWelcomeDesc,
          ticketWelcomeColor,
          ticketWelcomeThumbnail,
          ticketWelcomeImage,
          ticketWelcomeFooter
        })
      });
      if (!res.ok) throw new Error(m.e1_tickets_err_save());
      await dashboardStore.refresh();
      await loadTicketsAndConfig();
      success = true;
      return true;
    }, { successMessage: m.e1_tickets_config_saved() });
    return success;
  }

  async function runTicketSetup() {
    if (!(await confirmDialog.ask({
      title: m.e1_tickets_confirm_setup_title(),
      description: m.e1_tickets_confirm_setup_desc(),
      confirmLabel: m.e1_tickets_confirm_setup_btn()
    }))) return;

    // `run` range l'erreur dans son etat au lieu de la relancer, et cette page
    // n'affiche aucun InlineFeedback : sans ce relais, un refus de permission
    // ou un delai d'attente ne se verrait nulle part.
    const ok = await setupAction.run(async () => {
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/tickets/config/setup`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authStore.token}` }
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error || m.e1_tickets_err_setup());

      const created = (payload?.items ?? []).filter((item: any) => item.created).map((item: any) => `#${item.name}`);
      toast.success(created.length > 0
        ? m.e1_tickets_setup_created({ names: created.join(', ') })
        : m.e1_tickets_setup_nothing());

      await dashboardStore.refresh();
      await loadTicketsAndConfig();
      return true;
    });

    if (!ok) toast.error(setupAction.state.error || m.e1_tickets_err_setup());
  }

  // Send Panel to Discord
  async function sendEmbedPanel() {
    if (!(await confirmDialog.ask({ title: m.e1_tickets_confirm_panel_title(), description: m.e1_tickets_confirm_panel_desc(), confirmLabel: m.e1_tickets_confirm_panel_btn() }))) return;
    await sendEmbedAction.run(async () => {
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/tickets/config/send-embed`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authStore.token}` }
      });
      if (!res.ok) throw new Error(m.e1_tickets_err_send_panel());
      return true;
    }, { successMessage: m.e1_tickets_panel_sent() });
  }

  // Member Case Logic
  async function loadMemberCaseDetails(userId: string) {
    selectedCaseLoading = true;
    selectedCaseError = '';
    try {
      selectedCaseData = await fetchMemberCase(userId);
    } catch (err: any) {
      selectedCaseError = err.message || m.e1_tickets_err_load_case();
      selectedCaseData = null;
    } finally {
      selectedCaseLoading = false;
    }
  }

  function openMemberCase(userId: string, userName: string) {
    selectedCaseUser = { name: userName, id: userId };
    selectedCaseData = null;
    selectedCaseError = '';
    memberActionReason = m.e1_tickets_member_action_default_reason();
    memberActionDuration = '30m';
    memberActionFeedback = '';
    memberActionIsError = false;
    caseModalOpen = true;
    if (userId) {
      void loadMemberCaseDetails(userId);
    }
  }

  function closeCaseModal() {
    caseModalOpen = false;
    selectedCaseUser = null;
    selectedCaseData = null;
    selectedCaseError = '';
  }

  async function executeMemberAction(action: 'WARN' | 'KICK' | 'TIMEOUT' | 'BAN') {
    if (!selectedCaseUser?.id) return;
    memberActionBusy = true;
    memberActionFeedback = '';
    memberActionIsError = false;
    try {
      const durationMs = action === 'TIMEOUT' ? 30 * 60 * 1000 : null;
      await runMemberCaseAction(selectedCaseUser.id, action, {
        reason: memberActionReason.trim() || m.e1_tickets_action_reason_short(),
        durationMs: durationMs ?? undefined
      });
      memberActionFeedback = m.e1_tickets_action_success();
      await loadMemberCaseDetails(selectedCaseUser.id);
    } catch (err: any) {
      memberActionIsError = true;
      memberActionFeedback = err.message || m.e1_tickets_action_failed();
    } finally {
      memberActionBusy = false;
    }
  }

  function getStatusLabel(status: string) {
    switch (status) {
      case 'PENDING': return m.e1_tickets_status_pending();
      case 'OPEN': return m.e1_tickets_status_open();
      case 'CLAIMED': return m.e1_tickets_status_claimed();
      case 'CLOSED': return m.e1_tickets_status_closed();
      case 'ARCHIVED': return m.e1_tickets_status_archived();
      case 'REJECTED': return m.e1_tickets_status_rejected();
      default: return status;
    }
  }

  function getStatusColor(status: string) {
    switch (status) {
      case 'PENDING': return 'bg-sky-500/10 text-sky-400 border-sky-500/20';
      case 'OPEN': return 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20';
      case 'CLAIMED': return 'bg-amber-500/10 text-amber-500 border-amber-500/20';
      case 'CLOSED': return 'bg-rose-500/10 text-rose-500 border-rose-500/20';
      case 'ARCHIVED': return 'bg-slate-500/10 text-slate-400 border-slate-500/20';
      case 'REJECTED': return 'bg-rose-500/10 text-rose-400 border-rose-500/20';
      default: return 'bg-outline-variant/10 text-on-surface-variant border-outline-variant/20';
    }
  }

  // ─── Blacklist d'ouverture de tickets ──────────────────────────────────────
  type TicketBlacklistEntry = {
    id: string;
    userId: string;
    username: string | null;
    avatarUrl: string | null;
    reason: string | null;
    addedByTag: string | null;
    expiresAt: string | null;
    allowReopen: boolean;
    createdAt: string;
  };

  let blacklistEntries = $state<TicketBlacklistEntry[]>([]);
  let blacklistLoading = $state(false);
  let blacklistUserId = $state('');
  let blacklistReason = $state('');
  let blacklistDurationDays = $state('');
  let blacklistAllowReopen = $state(false);
  const blacklistAddAction = createAsyncActionState();

  async function loadBlacklist() {
    if (!authStore.selectedGuildId) return;
    blacklistLoading = true;
    try {
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/tickets/blacklist`, {
        headers: { 'Authorization': `Bearer ${authStore.token}` }
      });
      if (!res.ok) throw new Error(m.e1_tickets_bl_err_load());
      const data = await res.json();
      blacklistEntries = data.entries || [];
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      blacklistLoading = false;
    }
  }

  async function addToBlacklist() {
    const userId = blacklistUserId.trim();
    if (!/^\d{15,25}$/.test(userId)) {
      toast.error(m.e1_tickets_bl_err_invalid_id());
      return;
    }

    await blacklistAddAction.run(async () => {
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/tickets/blacklist`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authStore.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          reason: blacklistReason.trim() || null,
          durationDays: blacklistDurationDays.trim() ? Number(blacklistDurationDays) : null,
          allowReopen: blacklistAllowReopen,
        })
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || m.e1_tickets_bl_err_add());
      blacklistUserId = '';
      blacklistReason = '';
      blacklistDurationDays = '';
      blacklistAllowReopen = false;
      await loadBlacklist();
      return true;
    }, { successMessage: m.e1_tickets_bl_added() });
  }

  async function removeFromBlacklist(entry: TicketBlacklistEntry) {
    if (!(await confirmDialog.ask({
      title: m.e1_tickets_bl_remove_title(),
      description: m.e1_tickets_bl_remove_desc({ name: entry.username || entry.userId }),
      confirmLabel: m.e1_tickets_bl_remove_confirm(),
    }))) return;

    try {
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/tickets/blacklist/${entry.userId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${authStore.token}` }
      });
      if (!res.ok) throw new Error(m.e1_tickets_bl_err_remove());
      await loadBlacklist();
      toast.success(m.e1_tickets_bl_removed());
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  $effect(() => {
    if (activeTab === 'transcripts') {
      void loadTranscripts();
    } else if (activeTab === 'blacklist') {
      void loadBlacklist();
    } else if (activeTab === 'satisfaction') {
      void loadSatisfaction();
    } else if (activeTab === 'macros') {
      void loadMacros();
    }
  });

  // Serveur staff lié - pour l'option "ticket interne"
  let staffServerInfo = $state<{ staffGuildId: string | null; staffGuildName: string | null; categories: any[] }>({
    staffGuildId: null, staffGuildName: null, categories: [],
  });

  async function loadStaffServerInfo() {
    try {
      const data = await fetchStaffServerChannels();
      if (data?.staffGuildId) {
        staffServerInfo = {
          staffGuildId: data.staffGuildId,
          staffGuildName: data.staffGuildName ?? data.staffGuildId,
          categories: data.categories ?? [],
        };
      }
    } catch {
      // pas de lien staff
    }
  }

  onMount(async () => {
    await loadTicketsAndConfig();
    void loadStaffServerInfo();

    unsubscribeRealtime = subscribeRealtime({
      reasons: ['tickets_updated'],
      types: ['new_ticket_message'],
      onUpdate: (event) => {
        if (!event) {
          void refreshTicketsOnly();
          return;
        }

        if (event.type === 'new_ticket_message' && event.ticketId === selectedTicketId) {
          const msg = event.message as any;
          if (msg && !messages.some((m) => m.id === msg.id)) {
            messages = [
              ...messages.filter((m) => !m.id.startsWith('temp-') || m.content !== msg.content),
              msg,
            ];
            setTimeout(scrollToBottom, 50);
          }
          return;
        }

        if (event.reason === 'tickets_updated') {
          void refreshTicketsOnly();
        }
      },
    });
  });

  onDestroy(() => {
    unsubscribeRealtime?.();
  });
</script>

<ModulePage 
  title={m.e1_tickets_page_title()}
  description={m.e1_tickets_page_desc()}

  icon="message-square"
  featureKey="tickets"
>
  {#snippet actions()}
    <div class="flex items-center gap-3">
      <RefreshButton onClick={handleRefresh} loading={loading} label={m.e1_tickets_refresh()} />
      <button 
      onclick={() => changeTab(activeTab === 'config' ? 'tickets' : 'config')}
        class="p-3 rounded-xl bg-surface-container-high hover:bg-primary/10 hover:text-primary transition-all text-on-surface-variant/70"
        title={m.e1_tickets_settings_tooltip()}
      >
        <Papicon icon="settings" size={20} />
      </button>
    </div>
  {/snippet}

  <!-- Tab Switcher -->
  <div class="tickets-primary-tabs flex border-b border-outline-variant/10 mb-6 overflow-x-auto scrollbar-hide">
    {#each [
      { key: 'tickets', label: m.e1_tickets_tab_tickets() },
      { key: 'transcripts', label: m.e1_tickets_tab_transcripts() },
      { key: 'satisfaction', label: m.e1_tickets_tab_satisfaction() },
      { key: 'macros', label: 'Macros' },
      { key: 'blacklist', label: m.e1_tickets_tab_blacklist() },
      { key: 'config', label: m.e1_tickets_tab_config() }
    ] as tab}
      <button
        onclick={() => changeTab(tab.key as any)}
        class="tab-button {activeTab === tab.key ? 'active' : ''}"
      >
        {tab.label}
        {#if activeTab === tab.key}
          <div class="absolute bottom-0 left-0 w-full h-0.5 bg-primary rounded-t-full"></div>
        {/if}
      </button>
    {/each}
  </div>

  {#if activeTab === 'tickets'}
    <!-- Tickets Main View - mobile: master/detail pattern -->
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-4 lg:gap-6 h-auto lg:h-[75vh]">

      <!-- Left Panel: Tickets Browser -->
      <div class="lg:col-span-4 bg-surface-container-low/40 border border-outline-variant/10 rounded-xl p-4 lg:p-6 flex flex-col overflow-hidden {showMobileChat && selectedTicketId ? 'hidden lg:flex' : 'flex'} h-[50vh] lg:h-full">
        <div class="flex items-center gap-1.5 mb-4 overflow-x-auto pb-2 scrollbar-hide">
          {#each ['ALL', 'PENDING', 'OPEN', 'CLAIMED', 'CLOSED', 'ARCHIVED'] as filterType}
            <button
              onclick={() => changeTicketFilter(filterType as TicketFilter)}
              class="px-3 py-1.5 rounded-full text-xs font-medium transition-all whitespace-nowrap {ticketFilter === filterType ? 'bg-primary text-white shadow-md shadow-primary/20' : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'}"
            >
              {filterType === 'ALL' ? m.e1_tickets_filter_all() : getStatusLabel(filterType)}
            </button>
          {/each}
        </div>

        <div class="flex-1 overflow-y-auto space-y-2 pr-1 scrollbar-hide">
          {#if loading}
            {#each Array(5) as _}
              <div class="w-full p-3 lg:p-4 rounded-lg border border-outline-variant/10 bg-surface-container/30 animate-pulse">
                <div class="flex items-start gap-3">
                  <div class="w-9 h-9 lg:w-10 lg:h-10 rounded-xl bg-surface-container-high shrink-0"></div>
                  <div class="flex-1 min-w-0 space-y-2">
                    <div class="flex items-center justify-between gap-2">
                      <div class="h-3.5 w-24 bg-surface-container-high rounded-md"></div>
                      <div class="h-4 w-16 bg-surface-container-high rounded-full"></div>
                    </div>
                    <div class="h-2.5 w-40 bg-surface-container-high rounded-md"></div>
                    <div class="h-2 w-20 bg-surface-container-high rounded-md"></div>
                  </div>
                </div>
              </div>
            {/each}
          {:else if filteredTickets.length === 0}
            <div class="flex flex-col items-center justify-center py-16 text-on-surface-variant/30">
              <Papicon icon="inbox" size={28} class="opacity-50 mb-2" />
              <p class="text-xs font-bold">{m.e1_tickets_empty_list()}</p>
            </div>
          {:else}
            {#each filteredTickets as ticket (ticket.id)}
              <button
                onclick={() => { selectTicket(ticket.id); showMobileChat = true; }}
                class="w-full text-left p-3 lg:p-4 rounded-lg border transition-all duration-200 {selectedTicketId === ticket.id ? 'bg-primary/5 border-primary shadow-sm' : 'bg-surface-container/30 border-outline-variant/10 hover:border-outline-variant/40 hover:bg-surface-container/50'}"
              >
                <div class="flex items-start gap-3">
                  {#if ticket.userAvatar}
                    <img src={ticket.userAvatar} alt={ticket.username} class="w-9 h-9 lg:w-10 lg:h-10 rounded-xl object-cover shadow-sm shrink-0" />
                  {:else}
                    <div class="w-9 h-9 lg:w-10 lg:h-10 rounded-xl bg-surface-container flex items-center justify-center text-primary font-semibold text-sm shadow-sm shrink-0">
                      {ticket.username?.charAt(0).toUpperCase() || '?'}
                    </div>
                  {/if}
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center justify-between gap-2">
                      <p class="text-sm font-semibold text-on-surface truncate">@{ticket.username || m.e1_tickets_anonymous()}</p>
                      <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider border shrink-0 {getStatusColor(ticket.status)}">
                        {getStatusLabel(ticket.status)}
                      </span>
                    </div>
                    {#if ticket.reason}
                      <p class="text-[11px] text-on-surface-variant/70 mt-0.5 truncate">{ticket.reason}</p>
                    {/if}
                    <p class="text-[10px] text-on-surface-variant/40 mt-0.5">{new Date(ticket.createdAt).toLocaleDateString(dateLocale())}</p>
                  </div>
                </div>
                {#if ticket.claimedByName}
                  <div class="mt-2 pt-2 border-t border-outline-variant/10 flex items-center gap-1.5 text-[10px] font-semibold text-primary/80">
                    {#if ticket.claimedByAvatar}
                      <img src={ticket.claimedByAvatar} alt={ticket.claimedByName} class="w-5 h-5 rounded-full object-cover border border-primary/20" />
                    {:else}
                      <Papicon icon="user" size={11} />
                    {/if}
                    @{ticket.claimedByName}
                  </div>
                {/if}
              </button>
            {/each}
            {#if ticketsHasMore}
              <button
                type="button"
                onclick={() => loadTicketsAndConfig(false)}
                disabled={loadingMoreTickets}
                class="w-full mt-2 px-3 py-2 rounded-lg border border-outline-variant/20 bg-surface-container/40 text-xs font-medium text-on-surface-variant hover:bg-surface-container disabled:opacity-50"
              >
                {loadingMoreTickets ? m.e1_tickets_loading_more() : m.e1_tickets_load_more()}
              </button>
            {/if}
          {/if}
        </div>
      </div>

      <!-- Right Panel: Live Chat & Actions -->
      <div class="lg:col-span-8 bg-surface-container-low/40 border border-outline-variant/10 rounded-xl flex flex-col overflow-hidden {!showMobileChat && selectedTicketId ? 'hidden lg:flex' : !selectedTicketId ? 'hidden lg:flex' : 'flex'} h-[75vh] lg:h-full">
        {#if !selectedTicketId}
          <div class="flex-1 flex flex-col items-center justify-center text-on-surface-variant/30 py-20">
            <div class="w-16 h-16 rounded-xl bg-surface-container flex items-center justify-center mb-4 shadow-inner">
              <Papicon icon="message-square" size={32} />
            </div>
            <h3 class="text-lg font-semibold text-on-surface/40">{m.e1_tickets_no_selection_title()}</h3>
            <p class="text-xs opacity-60 mt-1">{m.e1_tickets_no_selection_desc()}</p>
          </div>
        {:else}
          <!-- Chat Header -->
          <div class="p-3 lg:p-5 border-b border-outline-variant/10 bg-surface-container/20">
            <div class="flex items-center gap-3">
              <!-- Mobile back button -->
              <button onclick={() => showMobileChat = false} class="lg:hidden p-2 -ml-1 rounded-lg hover:bg-surface-container transition-colors">
                <Papicon icon="arrow-left" size={18} />
              </button>
              {#if selectedTicketDetail?.userAvatar}
                <img src={selectedTicketDetail.userAvatar} alt={selectedTicketDetail.username} class="w-10 h-10 rounded-xl object-cover shadow-inner shrink-0" />
              {:else}
                <div class="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center font-semibold text-base shadow-inner shrink-0">
                  {selectedTicketDetail?.username?.charAt(0).toUpperCase() || '?'}
                </div>
              {/if}
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <h3 class="text-sm lg:text-base font-semibold text-on-surface truncate">@{selectedTicketDetail?.username || m.e1_tickets_user_fallback()}</h3>
                  <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider border {getStatusColor(selectedTicketDetail?.status)}">
                    {getStatusLabel(selectedTicketDetail?.status)}
                  </span>
                  {#if selectedTicketDetail?.mode && selectedTicketDetail.mode !== 'CHANNEL'}
                    <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider bg-blue-500/10 text-blue-400 border border-blue-500/20">
                      {selectedTicketDetail.mode === 'DM' ? m.e1_tickets_mode_dm() : m.e1_tickets_mode_thread()}
                    </span>
                  {/if}
                </div>
                {#if selectedTicketDetail?.claimedByName}
                  <div class="flex items-center gap-1 text-[10px] text-primary/80 font-bold">
                    {#if selectedTicketDetail.claimedByAvatar}
                      <img src={selectedTicketDetail.claimedByAvatar} alt={selectedTicketDetail.claimedByName} class="w-4 h-4 rounded-full object-cover" />
                    {/if}
                    {m.e1_tickets_assigned_to({ name: selectedTicketDetail.claimedByName })}
                  </div>
                {/if}
              </div>
            </div>

            <!-- Demande en attente ou refusée : aucun salon n'existe, l'écran
                 doit dire pourquoi plutôt que rester vide. -->
            {#if selectedTicketDetail?.status === 'PENDING'}
              <div class="mt-3 flex items-start gap-2 p-3 rounded-xl bg-sky-500/5 border border-sky-500/20">
                <Papicon icon="clock" size={14} class="text-sky-400 shrink-0 mt-0.5" />
                <p class="text-[11px] text-on-surface-variant">{m.e1_tickets_pending_notice()}</p>
              </div>
            {:else if selectedTicketDetail?.status === 'REJECTED'}
              <div class="mt-3 flex items-start gap-2 p-3 rounded-xl bg-rose-500/5 border border-rose-500/20">
                <Papicon icon="x-circle" size={14} class="text-rose-400 shrink-0 mt-0.5" />
                <p class="text-[11px] text-on-surface-variant">
                  {m.e1_tickets_rejected_notice({ name: selectedTicketDetail.reviewedByName || '-' })}
                  {#if selectedTicketDetail.rejectionReason}<br />{m.e1_tickets_rejected_reason({ reason: selectedTicketDetail.rejectionReason })}{/if}
                </p>
              </div>
            {/if}

            <!-- Quick actions - scrollable on mobile -->
            <div class="flex items-center gap-2 mt-3 overflow-x-auto pb-1 scrollbar-hide">
              <button
                onclick={() => openMemberCase(selectedTicketDetail.userId, selectedTicketDetail.username)}
                class="px-3 py-1.5 bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded-lg text-[10px] font-semibold uppercase tracking-wider hover:bg-indigo-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
              >
                <Papicon icon="shield" size={12} /> {m.e1_tickets_btn_case()}
              </button>

              {#if selectedTicketDetail?.status === 'OPEN'}
                {#if selectedTicketDetail.claimedBy !== authStore.user?.id}
                  <button onclick={claimTicket}
                    class="px-3 py-1.5 bg-amber-500/10 text-amber-500 border border-amber-500/20 rounded-lg text-[10px] font-semibold uppercase tracking-wider hover:bg-amber-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
                  >
                    <Papicon icon="user-check" size={12} /> {m.e1_tickets_btn_claim()}
                  </button>
                {/if}
                <button onclick={() => showCloseModal = true}
                  class="px-3 py-1.5 bg-rose-500/10 text-rose-500 border border-rose-500/20 rounded-lg text-[10px] font-semibold uppercase tracking-wider hover:bg-rose-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
                >
                  <Papicon icon="x-circle" size={12} /> {m.e1_tickets_btn_close()}
                </button>
              {/if}

              {#if selectedTicketDetail?.status === 'CLAIMED' && selectedTicketDetail.claimedById !== authStore.user?.id && (config.ticketAllowOverclaim ?? true) && config.ticketOverclaimPermission !== 'NONE'}
                <button onclick={claimTicket}
                  class="px-3 py-1.5 bg-amber-500/10 text-amber-500 border border-amber-500/20 rounded-lg text-[10px] font-semibold uppercase tracking-wider hover:bg-amber-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
                >
                  <Papicon icon="user-check" size={12} /> {m.e1_tickets_btn_overclaim()}
                </button>
              {/if}

              {#if selectedTicketDetail?.status === 'CLOSED' || selectedTicketDetail?.status === 'ARCHIVED'}
                {#if selectedTicketDetail.channelId}
                  <button onclick={reopenTicket}
                    class="px-3 py-1.5 bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 rounded-lg text-[10px] font-semibold uppercase tracking-wider hover:bg-emerald-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
                  >
                    <Papicon icon="refresh" size={12} /> {m.e1_tickets_btn_reopen()}
                  </button>

                  <!-- Archiver conserve tout : le salon passe en lecture seule
                       au lieu d'être détruit. C'est l'alternative à Supprimer,
                       posée juste avant lui pour se présenter d'abord. -->
                  {#if selectedTicketDetail.status === 'ARCHIVED'}
                    <button onclick={() => archiveTicket(true)}
                      class="px-3 py-1.5 bg-sky-500/10 text-sky-400 border border-sky-500/20 rounded-lg text-[10px] font-semibold uppercase tracking-wider hover:bg-sky-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
                    >
                      <Papicon icon="upload" size={12} /> {m.e1_tickets_btn_unarchive()}
                    </button>
                  {:else}
                    <button onclick={() => archiveTicket(false)}
                      class="px-3 py-1.5 bg-slate-500/10 text-slate-400 border border-slate-500/20 rounded-lg text-[10px] font-semibold uppercase tracking-wider hover:bg-slate-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
                    >
                      <Papicon icon="archive" size={12} /> {m.e1_tickets_btn_archive()}
                    </button>
                  {/if}

                  {#if deletionLock}
                    <button onclick={unlockTicket}
                      class="px-3 py-1.5 bg-amber-500/10 text-amber-500 border border-amber-500/20 rounded-lg text-[10px] font-semibold uppercase tracking-wider hover:bg-amber-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
                    >
                      <Papicon icon="unlock" size={12} /> {m.e1_tickets_btn_unlock()}
                    </button>
                  {:else}
                    <button onclick={() => showLockModal = true}
                      class="px-3 py-1.5 bg-outline-variant/10 text-on-surface-variant border border-outline-variant/20 rounded-lg text-[10px] font-semibold uppercase tracking-wider hover:bg-on-surface-variant hover:text-surface transition-all flex items-center gap-1.5 shrink-0"
                    >
                      <Papicon icon="lock" size={12} /> {m.e1_tickets_btn_lock()}
                    </button>
                  {/if}

                  <!-- Sous verrou le bouton reste visible mais inerte : le
                       masquer laisserait croire que la suppression n'existe pas. -->
                  <button onclick={() => { if (!deletionLock) showDeleteConfirmModal = true; }}
                    disabled={!!deletionLock}
                    title={deletionLock ? m.e1_tickets_delete_locked_hint() : undefined}
                    class="px-3 py-1.5 rounded-lg text-[10px] font-semibold uppercase tracking-wider active:scale-[0.98] transition-all flex items-center gap-1.5 shrink-0 {deletionLock ? 'bg-surface-container text-on-surface-variant/30 border border-outline-variant/10 cursor-not-allowed' : 'bg-rose-600 text-white'}"
                  >
                    <Papicon icon="delete" size={12} /> {m.e1_tickets_btn_delete()}
                  </button>
                {/if}
                {#if selectedTicketDetail?.transcriptId}
                  {@const restoresLeft = 3 - (selectedTicketDetail.restoreCount ?? 0)}
                  <button
                    onclick={() => { if (restoresLeft > 0) showRestoreModal = true; }}
                    disabled={restoresLeft <= 0}
                    title={restoresLeft <= 0 ? m.e1_tickets_restore_limit_tooltip() : m.e1_tickets_restore_left_tooltip({ count: restoresLeft })}
                    class="px-3 py-1.5 rounded-lg text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1.5 shrink-0 transition-all {restoresLeft > 0 ? 'bg-purple-500/10 text-purple-400 border border-purple-500/20 hover:bg-purple-500 hover:text-white cursor-pointer' : 'bg-surface-container text-on-surface-variant/30 border border-outline-variant/10 cursor-not-allowed'}"
                  >
                    <Papicon icon="refresh-ccw" size={12} /> {m.e1_tickets_btn_restore({ left: restoresLeft })}
                  </button>
                {/if}
              {/if}

              {#if selectedTicketDetail?.transcriptId}
                <a href="/transcripts/{selectedTicketDetail.transcriptId}" target="_blank"
                  class="px-3 py-1.5 bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-lg text-[10px] font-semibold uppercase tracking-wider hover:bg-blue-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
                >
                  <Papicon icon="external-link" size={12} /> {m.e1_tickets_original_transcript()}
                </a>
              {/if}
            </div>

            {#if deletionLock}
              <div class="mt-3 flex items-start gap-2 p-3 rounded-lg bg-amber-500/5 border border-amber-500/20">
                <Papicon icon="lock" size={14} class="text-amber-500 mt-0.5 shrink-0" />
                <div class="text-[11px] text-amber-400/90 leading-relaxed">
                  <p class="font-semibold">
                    {m.e1_tickets_lock_banner()}
                    · {deletionLock.until ? m.e1_tickets_lock_until({ date: new Date(deletionLock.until).toLocaleDateString() }) : m.e1_tickets_lock_permanent()}
                    {#if deletionLock.byName}· {m.e1_tickets_lock_by({ name: deletionLock.byName })}{/if}
                  </p>
                  {#if deletionLock.reason}<p class="mt-0.5 opacity-80">{deletionLock.reason}</p>{/if}
                </div>
              </div>
            {/if}

            {#if selectedTicketDetail?.channelId && selectedTicketDetail?.mode !== 'DM'}
              <div class="mt-3 flex gap-2 items-center">
                <FormInput type="text" bind:value={ticketRenameName} placeholder={m.e1_tickets_rename_ph()} className="flex-1" />
                <button onclick={renameTicket} disabled={renameAction.state.loading || !ticketRenameName.trim()}
                  class="px-3 py-2.5 bg-primary text-white rounded-lg text-[10px] font-semibold uppercase tracking-wider disabled:opacity-50 flex items-center gap-1.5 shrink-0"
                >
                  <Papicon icon="edit" size={12} />
                  {renameAction.state.loading ? '...' : m.e1_tickets_rename_btn()}
                </button>
              </div>
            {/if}
          </div>

          <!-- Chat Messages Container -->
          <div
            bind:this={chatScrollContainer}
            class="flex-1 overflow-y-auto bg-[#313338] scrollbar-hide"
            class:p-4={!selectedTicketDetail?.transcriptId || messages.length > 0}
            class:lg:p-6={!selectedTicketDetail?.transcriptId || messages.length > 0}
            class:space-y-3={!selectedTicketDetail?.transcriptId || messages.length > 0}
          >
            {#if loadingDetail && messages.length === 0}
              <div class="flex items-center justify-center h-full">
                <div class="w-8 h-8 rounded-full border-4 border-primary border-t-transparent animate-spin"></div>
              </div>
            {:else if messages.length === 0}
              {#if selectedTicketDetail?.transcriptId && signedTranscriptUrl}
                <iframe
                  src={signedTranscriptUrl}
                  title={m.e1_tickets_transcript_iframe_title()}
                  class="w-full h-full border-none bg-[#313338]"
                ></iframe>
              {:else}
                <div class="flex flex-col items-center justify-center text-white/30 h-full">
                  <Papicon icon="forum" size={28} class="opacity-50 mb-2" />
                  <p class="text-xs">{m.e1_tickets_no_message()}</p>
                </div>
              {/if}
            {:else}
              {#each messages as msg (msg.id)}
                <div class="flex items-start gap-2.5 lg:gap-4 p-2 rounded-xl hover:bg-white/5 transition-colors group">
                  <div class="shrink-0">
                    {#if msg.authorAvatar}
                      <img src={msg.authorAvatar} alt="Avatar" class="h-8 w-8 lg:h-10 lg:w-10 rounded-full object-cover border border-white/10" />
                    {:else}
                      <div class="h-8 w-8 lg:h-10 lg:w-10 rounded-full bg-white/10 flex items-center justify-center text-xs lg:text-sm font-semibold text-white/80">
                        {msg.authorName?.slice(0, 1).toUpperCase()}
                      </div>
                    {/if}
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-baseline gap-1.5 flex-wrap">
                      <span class="text-xs lg:text-sm font-bold text-white">{msg.authorName || m.e1_tickets_anonymous()}</span>
                      {#if msg.isStaff}
                        <span class="bg-[#5865F2] text-white text-[9px] lg:text-[11px] font-semibold uppercase px-1 py-0.5 rounded tracking-wider leading-none">{m.e1_tickets_staff_badge()}</span>
                      {/if}
                      <span class="text-[9px] lg:text-[10px] text-white/40">{new Date(msg.createdAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                    {#if msg.htmlContent}
                      <div class="text-xs lg:text-sm text-white/90 mt-1 whitespace-pre-wrap leading-relaxed select-text flex flex-wrap gap-x-1 items-center message-html-content">
                        {@html msg.htmlContent}
                      </div>
                    {:else if msg.content}
                      <p class="text-xs lg:text-sm text-white/90 mt-1 whitespace-pre-wrap leading-relaxed select-text">{msg.content}</p>
                    {/if}

                    {#if msg.mediaUrls && msg.mediaUrls.length > 0}
                      <div class="mt-2 space-y-2">
                        {#each msg.mediaUrls.filter((media: any) => {
                          if (msg.attachments?.some((att: any) => att.url === media.url)) return false;
                          const getFilename = (url: any) => { if (!url) return ''; const clean = url.split('?')[0]; const parts = clean.split('/'); return parts[parts.length - 1] || ''; };
                          const mediaFilename = getFilename(media.url);
                          if (msg.embeds?.some((embed: any) => {
                            const embedUrl = embed.url || ''; const embedImg = embed.image?.url || ''; const embedThumb = embed.thumbnail?.url || ''; const embedVid = embed.video?.url || '';
                            if (embedUrl === media.url || embedImg === media.url || embedThumb === media.url || embedVid === media.url) return true;
                            if (mediaFilename && (getFilename(embedUrl).includes(mediaFilename) || getFilename(embedImg).includes(mediaFilename) || getFilename(embedThumb).includes(mediaFilename) || getFilename(embedVid).includes(mediaFilename))) return true;
                            if (media.url.includes('giphy.com') && (embedUrl.includes('giphy.com') || embedImg.includes('giphy.com') || embedVid.includes('giphy.com') || embedThumb.includes('giphy.com'))) return true;
                            if (media.url.includes('tenor.com') && (embedUrl.includes('tenor.com') || embedImg.includes('tenor.com') || embedVid.includes('tenor.com') || embedThumb.includes('tenor.com'))) return true;
                            return false;
                          })) return false;
                          return true;
                        }) as media}
                          {#if media.type === 'image'}
                            <img src={media.url} alt="media-preview" class="max-w-[80%] lg:max-w-md rounded-lg border border-white/10 max-h-60 object-contain bg-[#1e1f22]" />
                          {:else if media.type === 'video'}
                            <!-- svelte-ignore a11y_media_has_caption -->
                            <video src={media.url} controls class="max-w-[80%] lg:max-w-md rounded-lg border border-white/10 max-h-60 bg-[#1e1f22]"></video>
                          {:else if media.type === 'audio'}
                            <audio src={media.url} controls class="max-w-[80%] lg:max-w-md"></audio>
                          {/if}
                        {/each}
                      </div>
                    {/if}

                    {#if msg.stickers && msg.stickers.length > 0}
                      <div class="mt-2 space-y-2">
                        {#each msg.stickers as sticker}
                          <div class="relative group max-w-[50%]">
                            <img src={sticker.url} alt={sticker.name} class="h-32 w-auto rounded-lg object-contain transition-transform" />
                          </div>
                        {/each}
                      </div>
                    {/if}

                    {#if msg.embeds && msg.embeds.length > 0}
                      <div class="mt-2 space-y-2">
                        {#each msg.embeds as embed}
                          <div class="bg-[#2b2d31] border-l-4 rounded-r-md p-2.5 max-w-full lg:max-w-lg" style="border-left-color: {embed.color || '#1e1f22'}">
                            {#if embed.title}
                              <div class="font-bold text-[#00a8fc] text-xs lg:text-sm mb-1">{embed.title}</div>
                            {/if}
                            {#if embed.htmlDescription}
                              <div class="text-xs lg:text-sm text-white/80 whitespace-pre-wrap leading-relaxed select-text message-html-content">{@html embed.htmlDescription}</div>
                            {:else if embed.description}
                              <div class="text-xs lg:text-sm text-white/80 whitespace-pre-wrap leading-relaxed select-text">{embed.description}</div>
                            {/if}
                            {#if embed.fields && embed.fields.length > 0}
                              <div class="mt-2 flex flex-wrap gap-2">
                                {#each embed.fields as field}
                                  <div class="flex-1 min-w-[45%]">
                                    <div class="text-[10px] font-bold text-white/60 uppercase">{field.name}</div>
                                    {#if field.htmlValue}
                                      <div class="text-xs text-white/80 select-text message-html-content">{@html field.htmlValue}</div>
                                    {:else}
                                      <div class="text-xs text-white/80 select-text">{field.value}</div>
                                    {/if}
                                  </div>
                                {/each}
                              </div>
                            {/if}
                            {#if embed.image?.url}
                              <img src={embed.image.url} alt="embed-img" class="mt-2 max-w-full rounded-lg border border-white/10 max-h-60 object-contain bg-[#1e1f22]" />
                            {:else if embed.video?.url}
                              {#if embed.video.url.includes('giphy.com') || embed.video.url.includes('tenor.com') || embed.video.url.includes('gifv')}
                                <video src={embed.video.url} autoplay loop muted playsinline class="mt-2 max-w-full rounded-lg border border-white/10 max-h-60 bg-[#1e1f22]"></video>
                              {:else}
                                <!-- svelte-ignore a11y_media_has_caption -->
                                <video src={embed.video.url} controls class="mt-2 max-w-full rounded-lg border border-white/10 max-h-60 bg-[#1e1f22]"></video>
                              {/if}
                            {:else if embed.thumbnail?.url}
                              <img src={embed.thumbnail.url} alt="embed-thumbnail" class="mt-2 max-w-full rounded-lg border border-white/10 max-h-32 object-contain bg-[#1e1f22]" />
                            {/if}
                          </div>
                        {/each}
                      </div>
                    {/if}

                    {#if msg.attachments && msg.attachments.length > 0}
                      <div class="mt-2 space-y-2">
                        {#each msg.attachments as att}
                          {#if att.contentType?.startsWith('image/')}
                            <img src={att.url} alt="discord-att" class="max-w-[80%] lg:max-w-md rounded-lg border border-white/10 max-h-60 object-cover" />
                          {:else if att.contentType?.startsWith('video/')}
                            <!-- svelte-ignore a11y_media_has_caption -->
                            <video src={att.url} controls class="max-w-[80%] lg:max-w-md rounded-lg border border-white/10 max-h-60"></video>
                          {:else if att.contentType?.startsWith('audio/')}
                            <audio src={att.url} controls class="max-w-[80%] lg:max-w-md"></audio>
                          {:else}
                            <a href={att.url} target="_blank" class="flex items-center gap-2 p-2.5 bg-white/5 border border-white/10 rounded-lg text-xs font-bold text-white hover:bg-white/10 transition-colors w-fit">
                              <Papicon icon="file" size={14} /> {m.e1_tickets_attachment()}
                            </a>
                          {/if}
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
              {/each}
            {/if}
          </div>

          <!-- Chat Input Bar -->
          {#if selectedTicketDetail?.status === 'OPEN' || selectedTicketDetail?.status === 'CLAIMED'}
            <div class="p-3 lg:p-4 border-t border-outline-variant/10 bg-surface-container/20 flex gap-2 lg:gap-3">
              <input
                type="text"
                bind:value={chatInput}
                onkeydown={(e) => e.key === 'Enter' && sendMessage()}
                placeholder={m.e1_tickets_message_ph()}
                class="flex-1 bg-surface-container rounded-lg px-4 py-3 focus:outline-hidden border-2 border-transparent focus:border-primary/50 text-sm"
              />
              <button
                onclick={sendMessage}
                disabled={!chatInput.trim()}
                class="w-11 h-11 rounded-lg bg-primary text-white flex items-center justify-center active:scale-[0.98] transition-transform disabled:opacity-50 shrink-0"
              >
                <Papicon icon="send" size={18} />
              </button>
            </div>
          {:else}
            <div class="p-3 lg:p-4 border-t border-outline-variant/10 bg-rose-500/10 text-rose-500 flex items-center justify-center text-xs font-medium gap-2">
              <Papicon icon="lock" size={14} /> {m.e1_tickets_closed_banner()}
            </div>
          {/if}
        {/if}
      </div>

    </div>
  {:else if activeTab === 'config'}
    {#await Promise.all([
      import('../lib/components/SearchableSelect.svelte'),
      import('../lib/components/EmojiPicker.svelte')
    ]) then configComponents}
    {@const SearchableSelect = configComponents[0].default}
    {@const EmojiPicker = configComponents[1].default}
    <!-- Configuration Panel - redesigned sections -->
    <div class="max-w-4xl mx-auto space-y-4">

      <!-- Header actions -->
      <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pb-2">
        <div>
          <h3 class="text-lg font-semibold text-on-surface">{m.e1_tickets_config_title()}</h3>
          <p class="text-on-surface-variant text-xs mt-0.5">{m.e1_tickets_config_desc()}</p>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <button
            onclick={runTicketSetup}
            disabled={setupAction.state.loading}
            class="px-4 py-2.5 bg-surface-container-high text-on-surface rounded-xl text-[10px] font-semibold uppercase tracking-wider active:scale-[0.98] transition-transform disabled:opacity-50 flex items-center gap-2 shrink-0"
          >
            <Papicon icon="sparkles" size={13} />
            {setupAction.state.loading ? m.e1_tickets_setup_running() : m.e1_tickets_setup()}
          </button>
          <button
            onclick={sendEmbedPanel}
            disabled={sendEmbedAction.state.loading || !ticketChannelId}
            class="px-4 py-2.5 bg-primary text-white rounded-xl text-[10px] font-semibold uppercase tracking-wider active:scale-[0.98] transition-transform disabled:opacity-50 flex items-center gap-2 shrink-0"
          >
            <Papicon icon="send" size={13} />
            {sendEmbedAction.state.loading ? m.e1_tickets_sending() : m.e1_tickets_send_embed()}
          </button>
        </div>
      </div>

      <!-- ─── Préparation ────────────────────────────────────────────────
           Les trois réglages sans lesquels un membre ne peut pas ouvrir de
           ticket, séparés de la trentaine d'options d'affinage qui suivent.
           Ils étaient noyés dans le premier accordéon, replié par défaut. -->
      {#if configBlockers.length > 0}
        <div class="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3.5">
          <div class="flex items-start gap-3">
            <Papicon icon="alert-triangle" size={16} class="text-amber-500 mt-0.5 shrink-0" />
            <div class="min-w-0">
              <p class="text-[13px] font-semibold text-on-surface">
                Les tickets ne sont pas encore opérationnels
              </p>
              <p class="text-[12px] text-on-surface-variant mt-1 leading-relaxed">
                Il manque {configBlockers.length === 1 ? 'un réglage' : `${configBlockers.length} réglages`} :
                {configBlockers.map((b) => b.label).join(', ')}.
                Un membre qui clique sur le panneau n'obtiendra rien tant qu'ils ne sont pas remplis.
              </p>
              <button
                type="button"
                class="mt-2.5 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium
                bg-amber-500/15 text-amber-500 border border-amber-500/30 hover:bg-amber-500/25 transition-colors"
                onclick={() => (expandedConfigSection = 'channels')}
              >
                <Papicon icon="arrow-right" size={13} />
                Compléter
              </button>
            </div>
          </div>
        </div>
      {:else}
        <div class="rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-4 py-3 flex items-center gap-3">
          <Papicon icon="check-circle" size={16} class="text-emerald-500 shrink-0" />
          <p class="text-[12.5px] text-on-surface">
            Les tickets sont opérationnels. Le reste de cette page en affine le comportement.
          </p>
        </div>
      {/if}

      <!-- ─── Section 1: Salons & Rôles ──────────────────────────────────── -->
      <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 overflow-hidden">
        <button onclick={() => toggleConfigSection('channels')} class="w-full flex items-center justify-between p-4 lg:p-5 hover:bg-white/3 transition-colors text-left">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center shrink-0">
              <Papicon icon="hash" size={18} />
            </div>
            <div>
              <p class="text-sm font-semibold text-on-surface">{m.e1_tickets_sec_channels_title()}</p>
              <p class="text-[10px] text-on-surface-variant/60 mt-0.5">{m.e1_tickets_sec_channels_desc()}</p>
            </div>
          </div>
          <Papicon icon={expandedConfigSection === 'channels' ? 'chevron-up' : 'chevron-down'} size={16} class="text-on-surface-variant/40 shrink-0" />
        </button>
        {#if expandedConfigSection === 'channels'}
          <div class="px-4 lg:px-5 pb-5 space-y-4 border-t border-outline-variant/10 pt-4">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_category()}</span>
                <SearchableSelect bind:value={ticketCategoryId} options={discordCategories.map(c => ({ id: c.id, name: c.name }))} placeholder={m.e1_tickets_select_ph()} className="w-full" />
                {#if isMissingReference(ticketCategoryId, discordCategories)}
                  <p class="text-[10px] text-amber-500 mt-1.5">{m.e1_tickets_missing_ref()}</p>
                {/if}
              </label>
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_panel_channel()}</span>
                <SearchableSelect bind:value={ticketChannelId} options={discordChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))} placeholder={m.e1_tickets_select_ph()} className="w-full" />
                {#if isMissingReference(ticketChannelId, discordChannels)}
                  <p class="text-[10px] text-amber-500 mt-1.5">{m.e1_tickets_missing_ref()}</p>
                {/if}
              </label>
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_log_channel()}</span>
                <SearchableSelect bind:value={ticketLogChannelId} options={discordChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))} placeholder={m.e1_tickets_select_ph()} className="w-full" />
                {#if isMissingReference(ticketLogChannelId, discordChannels)}
                  <p class="text-[10px] text-amber-500 mt-1.5">{m.e1_tickets_missing_ref()}</p>
                {/if}
              </label>
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_staff_role()}</span>
                <SearchableSelect bind:value={ticketStaffRoleId} options={discordRoles.map(r => ({ id: r.id, name: `@${r.name}` }))} placeholder={m.e1_tickets_select_ph()} className="w-full" />
                {#if isMissingReference(ticketStaffRoleId, discordRoles)}
                  <p class="text-[10px] text-amber-500 mt-1.5">{m.e1_tickets_missing_ref()}</p>
                {/if}
              </label>
              <label class="block col-span-1 md:col-span-2">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_dm_relay()}</span>
                <SearchableSelect bind:value={ticketDmRelayChannelId} options={discordChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))} placeholder={m.e1_tickets_select_channel_ph()} className="w-full" />
                {#if isMissingReference(ticketDmRelayChannelId, discordChannels)}
                  <p class="text-[10px] text-amber-500 mt-1.5">{m.e1_tickets_missing_ref()}</p>
                {/if}
              </label>
            </div>

            <div class="border-t border-outline-variant/10 pt-4 space-y-3">
              <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
                <input type="checkbox" bind:checked={ticketAllowOverclaim} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
                <div>
                  <span class="text-xs font-bold text-on-surface">{m.e1_tickets_overclaim_label()}</span>
                  <p class="text-[10px] text-on-surface-variant/60">{m.e1_tickets_overclaim_desc()}</p>
                </div>
              </label>
              {#if ticketAllowOverclaim}
                <label class="block ml-7">
                  <span class="text-xs font-bold text-on-surface-variant/80 mb-2 block">{m.e1_tickets_overclaim_who()}</span>
                  <FormSelect bind:value={ticketOverclaimPermission} className="w-full">
                    <option value="ANY">{m.e1_tickets_overclaim_any()}</option>
                    <option value="SUPERIOR_OR_EQUAL">{m.e1_tickets_overclaim_superior()}</option>
                  </FormSelect>
                </label>
              {/if}
              <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
                <input type="checkbox" bind:checked={ticketAutoClaimOnReply} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
                <div>
                  <span class="text-xs font-bold text-on-surface">{m.e1_tickets_autoclaim_label()}</span>
                  <p class="text-[10px] text-on-surface-variant/60">{m.e1_tickets_autoclaim_desc()}</p>
                </div>
              </label>
            </div>
          </div>
        {/if}
      </div>

      <!-- ─── Section 3: Personnalisation Embed ──────────────────────────── -->
      <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 overflow-hidden">
        <button onclick={() => toggleConfigSection('embed')} class="w-full flex items-center justify-between p-4 lg:p-5 hover:bg-white/3 transition-colors text-left">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-lg bg-purple-500/10 text-purple-400 flex items-center justify-center shrink-0">
              <Papicon icon="palette" size={18} />
            </div>
            <div>
              <p class="text-sm font-semibold text-on-surface">{m.e1_tickets_sec_embed_title()}</p>
              <p class="text-[10px] text-on-surface-variant/60 mt-0.5">{m.e1_tickets_sec_embed_desc()}</p>
            </div>
          </div>
          <Papicon icon={expandedConfigSection === 'embed' ? 'chevron-up' : 'chevron-down'} size={16} class="text-on-surface-variant/40 shrink-0" />
        </button>
        {#if expandedConfigSection === 'embed'}
          <div class="px-4 lg:px-5 pb-5 space-y-4 border-t border-outline-variant/10 pt-4">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_title()}</span>
                <FormInput type="text" bind:value={ticketEmbedTitle} placeholder={m.e1_tickets_embed_title_ph()} className="w-full" />
              </label>
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_button_text()}</span>
                <FormInput type="text" bind:value={ticketEmbedButtonText} placeholder={m.e1_tickets_embed_button_ph()} className="w-full" />
              </label>
            </div>
            <label class="block">
              <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_description()}</span>
              <FormTextarea bind:value={ticketEmbedDesc} placeholder={m.e1_tickets_embed_desc_ph()} className="w-full h-20" />
              <p class="text-[10px] text-on-surface-variant/50 mt-1.5">{m.e1_tickets_default_hint()}</p>
            </label>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_thumbnail()}</span>
                <FormInput type="text" bind:value={ticketEmbedThumbnail} placeholder="https://..." className="w-full" />
              </label>
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_image()}</span>
                <FormInput type="text" bind:value={ticketEmbedImage} placeholder="https://..." className="w-full" />
              </label>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_author_name()}</span>
                <FormInput type="text" bind:value={ticketEmbedAuthorName} placeholder={m.e1_tickets_embed_author_ph()} className="w-full" />
              </label>
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_author_icon()}</span>
                <FormInput type="text" bind:value={ticketEmbedAuthorIcon} placeholder="https://..." className="w-full" />
              </label>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_color()}</span>
                <FormColorPicker bind:value={ticketEmbedColor} />
              </label>
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_footer()}</span>
                <FormInput type="text" bind:value={ticketEmbedFooter} placeholder={m.e1_tickets_embed_footer_ph()} className="w-full" />
              </label>
            </div>

            <div class="border-t border-outline-variant/10 pt-4">
              <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-3 block">{m.e1_tickets_interaction_type()}</span>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {#each [
                  { value: 'BUTTONS', label: m.e1_tickets_interaction_buttons(), icon: 'mouse-pointer', desc: m.e1_tickets_interaction_buttons_desc() },
                  { value: 'DROPDOWN', label: m.e1_tickets_interaction_dropdown(), icon: 'list', desc: m.e1_tickets_interaction_dropdown_desc() }
                ] as typeOption}
                  <button
                    onclick={() => ticketEmbedType = typeOption.value as any}
                    class="p-4 rounded-xl border-2 text-left transition-all {ticketEmbedType === typeOption.value ? 'border-primary bg-primary/5' : 'border-outline-variant/10 hover:border-outline-variant/30 bg-surface-container/20'}"
                  >
                    <div class="flex items-center gap-2.5 mb-2">
                      <div class="w-8 h-8 rounded-lg flex items-center justify-center {ticketEmbedType === typeOption.value ? 'bg-primary/15 text-primary' : 'bg-surface-container text-on-surface-variant/50'}">
                        <Papicon icon={typeOption.icon} size={16} />
                      </div>
                      <span class="text-sm font-semibold {ticketEmbedType === typeOption.value ? 'text-primary' : 'text-on-surface'}">{typeOption.label}</span>
                    </div>
                    <p class="text-[10px] text-on-surface-variant/60 leading-relaxed">{typeOption.desc}</p>
                  </button>
                {/each}
              </div>
            </div>
          </div>
        {/if}
      </div>



      <!-- ─── Section: Message d'accueil dans le ticket ──────────────────────────── -->
      <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 overflow-hidden">
        <button onclick={() => toggleConfigSection('welcome')} class="w-full flex items-center justify-between p-4 lg:p-5 hover:bg-white/3 transition-colors text-left">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-lg bg-blue-500/10 text-blue-400 flex items-center justify-center shrink-0">
              <Papicon icon="message-square" size={18} />
            </div>
            <div>
              <p class="text-sm font-semibold text-on-surface">{m.e1_tickets_sec_welcome_title()}</p>
              <p class="text-[10px] text-on-surface-variant/60 mt-0.5">{m.e1_tickets_sec_welcome_desc()}</p>
            </div>
          </div>
          <Papicon icon={expandedConfigSection === 'welcome' ? 'chevron-up' : 'chevron-down'} size={16} class="text-on-surface-variant/40 shrink-0" />
        </button>
        {#if expandedConfigSection === 'welcome'}
          <div class="px-4 lg:px-5 pb-5 space-y-4 border-t border-outline-variant/10 pt-4">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label class="block col-span-1 md:col-span-2">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_welcome_title_label()}</span>
                <FormInput type="text" bind:value={ticketWelcomeTitle} placeholder={m.e1_tickets_welcome_title_ph({ type_label: '{type_label}' })} className="w-full" />
              </label>
            </div>
            <label class="block">
              <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_welcome_desc_label()}</span>
              <FormTextarea bind:value={ticketWelcomeDesc} placeholder={m.e1_tickets_welcome_desc_ph({ user: '{user}', staff_mention: '{staff_mention}' })} className="w-full h-32" />
              <p class="text-[10px] text-on-surface-variant/50 mt-1.5">{m.e1_tickets_default_hint()}</p>
            </label>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_thumbnail()}</span>
                <FormInput type="text" bind:value={ticketWelcomeThumbnail} placeholder="https://..." className="w-full" />
              </label>
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_image()}</span>
                <FormInput type="text" bind:value={ticketWelcomeImage} placeholder="https://..." className="w-full" />
              </label>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_embed_color()}</span>
                <FormColorPicker bind:value={ticketWelcomeColor} />
              </label>
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_field_footer()}</span>
                <FormInput type="text" bind:value={ticketWelcomeFooter} placeholder={m.e1_tickets_welcome_footer_ph({ ticket_id: '{ticket_id}' })} className="w-full" />
              </label>
            </div>
          </div>
        {/if}
      </div>

      <!-- ─── Section : Validation & verrouillage ────────────────────────── -->
      <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 overflow-hidden">
        <button onclick={() => toggleConfigSection('gatekeeping')} class="w-full flex items-center justify-between p-4 lg:p-5 hover:bg-white/3 transition-colors text-left">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-lg bg-sky-500/10 text-sky-400 flex items-center justify-center shrink-0">
              <Papicon icon="shield" size={18} />
            </div>
            <div>
              <p class="text-sm font-semibold text-on-surface">{m.e1_tickets_sec_gatekeeping_title()}</p>
              <p class="text-[10px] text-on-surface-variant/60 mt-0.5">{m.e1_tickets_sec_gatekeeping_desc()}</p>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            {#if ticketLockUntilClaim || ticketApprovalEnabled}
              <span class="px-2 py-0.5 rounded-full text-[9px] font-semibold uppercase bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">{m.e1_tickets_active_badge()}</span>
            {/if}
            <Papicon icon={expandedConfigSection === 'gatekeeping' ? 'chevron-up' : 'chevron-down'} size={16} class="text-on-surface-variant/40" />
          </div>
        </button>
        {#if expandedConfigSection === 'gatekeeping'}
          <div class="px-4 lg:px-5 pb-5 space-y-4 border-t border-outline-variant/10 pt-4">
            <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
              <input type="checkbox" bind:checked={ticketLockUntilClaim} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
              <div>
                <span class="text-xs font-bold text-on-surface">{m.e1_tickets_lock_until_claim()}</span>
                <p class="text-[10px] text-on-surface-variant/60">{m.e1_tickets_lock_until_claim_desc()}</p>
              </div>
            </label>

            <div class="border-t border-outline-variant/10 pt-4 space-y-3">
              <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
                <input type="checkbox" bind:checked={ticketApprovalEnabled} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
                <div>
                  <span class="text-xs font-bold text-on-surface">{m.e1_tickets_approval_enable()}</span>
                  <p class="text-[10px] text-on-surface-variant/60">{m.e1_tickets_approval_enable_desc()}</p>
                </div>
              </label>
              {#if ticketApprovalEnabled}
                <label class="block ml-7">
                  <span class="text-xs font-bold text-on-surface-variant/80 mb-2 block">{m.e1_tickets_approval_channel()}</span>
                  <SearchableSelect bind:value={ticketApprovalChannelId} options={discordChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))} placeholder={m.e1_tickets_approval_channel_ph()} className="w-full" />
                  {#if isMissingReference(ticketApprovalChannelId, discordChannels)}
                    <p class="text-[10px] text-amber-500 mt-1.5">{m.e1_tickets_missing_ref()}</p>
                  {/if}
                  <p class="text-[10px] text-on-surface-variant/50 mt-1.5">{m.e1_tickets_approval_channel_hint()}</p>
                </label>
              {/if}
            </div>

            <p class="text-[10px] text-on-surface-variant/50 border-t border-outline-variant/10 pt-3">{m.e1_tickets_gatekeeping_override_hint()}</p>
          </div>
        {/if}
      </div>

      <!-- ─── Section : Archivage & historique côté membre ───────────────── -->
      <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 overflow-hidden">
        <button onclick={() => toggleConfigSection('archive')} class="w-full flex items-center justify-between p-4 lg:p-5 hover:bg-white/3 transition-colors text-left">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-lg bg-slate-500/10 text-slate-400 flex items-center justify-center shrink-0">
              <Papicon icon="archive" size={18} />
            </div>
            <div>
              <p class="text-sm font-semibold text-on-surface">{m.e1_tickets_cfg_archive_title()}</p>
              <p class="text-[10px] text-on-surface-variant/60 mt-0.5">{m.e1_tickets_cfg_archive_desc()}</p>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            {#if ticketArchiveCategoryId || ticketHistoryPanelEnabled}
              <span class="px-2 py-0.5 rounded-full text-[9px] font-semibold uppercase bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">{m.e1_tickets_active_badge()}</span>
            {/if}
            <Papicon icon={expandedConfigSection === 'archive' ? 'chevron-up' : 'chevron-down'} size={16} class="text-on-surface-variant/40" />
          </div>
        </button>
        {#if expandedConfigSection === 'archive'}
          <div class="px-4 lg:px-5 pb-5 space-y-4 border-t border-outline-variant/10 pt-4">
            <label class="block">
              <span class="text-xs font-bold text-on-surface-variant/80 mb-2 block">{m.e1_tickets_cfg_archive_category()}</span>
              <SearchableSelect bind:value={ticketArchiveCategoryId} options={discordCategories.map(c => ({ id: c.id, name: c.name }))} placeholder={m.e1_tickets_select_ph()} className="w-full" />
              {#if isMissingReference(ticketArchiveCategoryId, discordCategories)}
                <p class="text-[10px] text-amber-500 mt-1.5">{m.e1_tickets_missing_ref()}</p>
              {/if}
              <p class="text-[10px] text-on-surface-variant/50 mt-1.5">{m.e1_tickets_cfg_archive_category_hint()}</p>
            </label>

            <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
              <input type="checkbox" bind:checked={ticketArchiveKeepOpenerView} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
              <div>
                <span class="text-xs font-bold text-on-surface">{m.e1_tickets_cfg_archive_keep_view()}</span>
                <p class="text-[10px] text-on-surface-variant/60">{m.e1_tickets_cfg_archive_keep_view_desc()}</p>
              </div>
            </label>

            <div class="border-t border-outline-variant/10 pt-4 space-y-3">
              <div>
                <p class="text-xs font-bold text-on-surface">{m.e1_tickets_cfg_history_title()}</p>
                <p class="text-[10px] text-on-surface-variant/60 mt-0.5">{m.e1_tickets_cfg_history_desc()}</p>
              </div>

              <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
                <input type="checkbox" bind:checked={ticketHistoryPanelEnabled} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
                <div>
                  <span class="text-xs font-bold text-on-surface">{m.e1_tickets_cfg_history_panel()}</span>
                  <p class="text-[10px] text-on-surface-variant/60">{m.e1_tickets_cfg_history_panel_desc()}</p>
                </div>
              </label>

              {#if ticketHistoryPanelEnabled}
                <div class="ml-7 space-y-3">
                  <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
                    <input type="checkbox" bind:checked={ticketSelfReopenEnabled} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
                    <div>
                      <span class="text-xs font-bold text-on-surface">{m.e1_tickets_cfg_self_reopen()}</span>
                      <p class="text-[10px] text-on-surface-variant/60">{m.e1_tickets_cfg_self_reopen_desc()}</p>
                    </div>
                  </label>
                  <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
                    <input type="checkbox" bind:checked={ticketSelfDeleteEnabled} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
                    <div>
                      <span class="text-xs font-bold text-on-surface">{m.e1_tickets_cfg_self_delete()}</span>
                      <p class="text-[10px] text-on-surface-variant/60">{m.e1_tickets_cfg_self_delete_desc()}</p>
                    </div>
                  </label>
                </div>
              {/if}
            </div>
          </div>
        {/if}
      </div>

      <!-- ─── Section 4: Inactivité ──────────────────────────────────────── -->
      <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 overflow-hidden">
        <button onclick={() => toggleConfigSection('inactivity')} class="w-full flex items-center justify-between p-4 lg:p-5 hover:bg-white/3 transition-colors text-left">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-lg bg-amber-500/10 text-amber-400 flex items-center justify-center shrink-0">
              <Papicon icon="clock" size={18} />
            </div>
            <div>
              <p class="text-sm font-semibold text-on-surface">{m.e1_tickets_sec_inactivity_title()}</p>
              <p class="text-[10px] text-on-surface-variant/60 mt-0.5">{m.e1_tickets_sec_inactivity_desc()}</p>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            {#if ticketInactivityEnabled}
              <span class="px-2 py-0.5 rounded-full text-[9px] font-semibold uppercase bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">{m.e1_tickets_active_badge()}</span>
            {/if}
            <Papicon icon={expandedConfigSection === 'inactivity' ? 'chevron-up' : 'chevron-down'} size={16} class="text-on-surface-variant/40" />
          </div>
        </button>
        {#if expandedConfigSection === 'inactivity'}
          <div class="px-4 lg:px-5 pb-5 space-y-4 border-t border-outline-variant/10 pt-4">
            <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
              <input type="checkbox" bind:checked={ticketInactivityEnabled} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
              <div>
                <span class="text-xs font-bold text-on-surface">{m.e1_tickets_enable_reminders()}</span>
                <p class="text-[10px] text-on-surface-variant/60">{m.e1_tickets_reminders_desc()}</p>
              </div>
            </label>
            {#if ticketInactivityEnabled}
              <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <label class="block">
                  <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_delay_hours()}</span>
                  <input type="number" bind:value={ticketInactivityHours} min={1} max={168} class="w-full bg-surface-container-high text-sm px-4 py-2.5 rounded-xl border border-outline-variant/10 focus:ring-1 ring-primary/30 transition-all outline-none" />
                </label>
                <label class="block sm:col-span-2">
                  <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_inactivity_message_label()}</span>
                  <FormTextarea bind:value={ticketInactivityMessage} placeholder={m.e1_tickets_inactivity_ph({ user: '{user}' })} className="w-full h-20" />
                </label>
              </div>
            {/if}
          </div>
        {/if}
      </div>

      <!-- ─── Quotas ─────────────────────────────────────────────────────── -->
      <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 overflow-hidden">
        <button onclick={() => toggleConfigSection('quotas')} class="w-full flex items-center justify-between p-4 lg:p-5 hover:bg-white/3 transition-colors text-left">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-lg bg-sky-500/10 text-sky-400 flex items-center justify-center shrink-0">
              <Papicon icon="gauge" size={18} />
            </div>
            <div>
              <p class="text-sm font-semibold text-on-surface">Quotas</p>
              <p class="text-[10px] text-on-surface-variant/60 mt-0.5">Limites d'ouverture côté membre, plafond de charge côté staff</p>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            {#if activeQuotaCount > 0}
              <span class="px-2 py-0.5 rounded-full text-[9px] font-semibold uppercase bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
                {activeQuotaCount} actif{activeQuotaCount > 1 ? 's' : ''}
              </span>
            {/if}
            <Papicon icon={expandedConfigSection === 'quotas' ? 'chevron-up' : 'chevron-down'} size={16} class="text-on-surface-variant/40" />
          </div>
        </button>
        {#if expandedConfigSection === 'quotas'}
          <div class="px-4 lg:px-5 pb-5 space-y-4 border-t border-outline-variant/10 pt-4">
            <p class="text-[11px] text-on-surface-variant/70 leading-relaxed">
              Chaque quota s'active indépendamment. Décoché, il n'impose aucune limite.
              Un type de ticket peut ajuster le seuil depuis l'onglet Types.
            </p>

            <div class="border-t border-outline-variant/10 pt-4 space-y-3">
              <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
                <input type="checkbox" bind:checked={ticketQuotaOpenEnabled} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
                <div>
                  <span class="text-xs font-bold text-on-surface">Tickets ouverts simultanément</span>
                  <p class="text-[10px] text-on-surface-variant/60">Nombre de tickets qu'un membre peut avoir en cours en même temps.</p>
                </div>
              </label>
              {#if ticketQuotaOpenEnabled}
                <label class="block ml-7 max-w-[220px]">
                  <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Maximum par membre</span>
                  <input type="number" bind:value={ticketQuotaOpenMax} min={1} max={50} class="w-full bg-surface-container-high text-sm px-4 py-2.5 rounded-xl border border-outline-variant/10 focus:ring-1 ring-primary/30 transition-all outline-none" />
                </label>
              {/if}
            </div>

            <div class="border-t border-outline-variant/10 pt-4 space-y-3">
              <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
                <input type="checkbox" bind:checked={ticketQuotaCooldownEnabled} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
                <div>
                  <span class="text-xs font-bold text-on-surface">Délai entre deux ouvertures</span>
                  <p class="text-[10px] text-on-surface-variant/60">Empêche d'enchaîner les tickets sans laisser le temps de répondre.</p>
                </div>
              </label>
              {#if ticketQuotaCooldownEnabled}
                <label class="block ml-7 max-w-[220px]">
                  <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Délai (minutes)</span>
                  <input type="number" bind:value={ticketQuotaCooldownMinutes} min={1} max={10080} class="w-full bg-surface-container-high text-sm px-4 py-2.5 rounded-xl border border-outline-variant/10 focus:ring-1 ring-primary/30 transition-all outline-none" />
                </label>
              {/if}
            </div>

            <div class="border-t border-outline-variant/10 pt-4 space-y-3">
              <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
                <input type="checkbox" bind:checked={ticketQuotaPeriodEnabled} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
                <div>
                  <span class="text-xs font-bold text-on-surface">Quota sur une période</span>
                  <p class="text-[10px] text-on-surface-variant/60">Plafonne le nombre d'ouvertures sur une fenêtre glissante.</p>
                </div>
              </label>
              {#if ticketQuotaPeriodEnabled}
                <div class="ml-7 grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-[460px]">
                  <label class="block">
                    <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Tickets maximum</span>
                    <input type="number" bind:value={ticketQuotaPeriodMax} min={1} max={500} class="w-full bg-surface-container-high text-sm px-4 py-2.5 rounded-xl border border-outline-variant/10 focus:ring-1 ring-primary/30 transition-all outline-none" />
                  </label>
                  <label class="block">
                    <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Sur (heures)</span>
                    <input type="number" bind:value={ticketQuotaPeriodHours} min={1} max={720} class="w-full bg-surface-container-high text-sm px-4 py-2.5 rounded-xl border border-outline-variant/10 focus:ring-1 ring-primary/30 transition-all outline-none" />
                  </label>
                </div>
              {/if}
            </div>

            <div class="border-t border-outline-variant/10 pt-4 space-y-3">
              <div>
                <p class="text-xs font-bold text-on-surface">Charge maximale par modérateur</p>
                <p class="text-[10px] text-on-surface-variant/60 mt-0.5">
                  Tickets pris en charge et encore ouverts. Au-delà, le staff est averti ou refusé.
                </p>
              </div>
              <div class="flex flex-wrap gap-2">
                {#each STAFF_LOAD_MODES as opt (opt.value)}
                  <button
                    type="button"
                    class="px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition-colors
                    {ticketQuotaStaffLoadMode === opt.value
                      ? 'bg-primary/15 border-primary/40 text-primary'
                      : 'bg-surface-container-high border-outline-variant/20 text-on-surface-variant hover:text-on-surface'}"
                    onclick={() => (ticketQuotaStaffLoadMode = opt.value)}
                  >
                    {opt.label}
                  </button>
                {/each}
              </div>
              {#if ticketQuotaStaffLoadMode !== 'OFF'}
                <div class="space-y-3">
                  <label class="block max-w-[220px]">
                    <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Tickets par modérateur</span>
                    <input type="number" bind:value={ticketQuotaStaffLoadMax} min={1} max={200} class="w-full bg-surface-container-high text-sm px-4 py-2.5 rounded-xl border border-outline-variant/10 focus:ring-1 ring-primary/30 transition-all outline-none" />
                  </label>
                  <div>
                    <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-1 block">Rôles qui passent outre</span>
                    <p class="text-[10px] text-on-surface-variant/60 ml-1 mb-2">
                      Sans eux, un serveur dont tout le staff est plein ne peut plus prendre aucun ticket.
                    </p>
                    <MultiSelect
                      bind:values={ticketQuotaStaffLoadBypassRoleIds}
                      options={discordRoles.map(r => ({ id: r.id, name: `@${r.name}` }))}
                      placeholder="Aucun rôle"
                    />
                  </div>
                </div>
              {/if}
            </div>

            <div class="border-t border-outline-variant/10 pt-4 space-y-3">
              <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
                <input type="checkbox" bind:checked={ticketQuotaReopenEnabled} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
                <div>
                  <span class="text-xs font-bold text-on-surface">Limiter les réouvertures</span>
                  <p class="text-[10px] text-on-surface-variant/60">
                    Nombre de fois qu'un même ticket peut être rouvert. Les délais entre deux réouvertures
                    (24 h, puis 7 jours) s'appliquent quoi qu'il arrive.
                  </p>
                </div>
              </label>
              {#if ticketQuotaReopenEnabled}
                <label class="block ml-7 max-w-[220px]">
                  <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Réouvertures maximum</span>
                  <input type="number" bind:value={ticketQuotaReopenMax} min={1} max={50} class="w-full bg-surface-container-high text-sm px-4 py-2.5 rounded-xl border border-outline-variant/10 focus:ring-1 ring-primary/30 transition-all outline-none" />
                </label>
              {/if}
            </div>
          </div>
        {/if}
      </div>

      <!-- ─── Section 5: Sondage de satisfaction ─────────────────────────── -->
      <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 overflow-hidden">
        <button onclick={() => toggleConfigSection('satisfaction')} class="w-full flex items-center justify-between p-4 lg:p-5 hover:bg-white/3 transition-colors text-left">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center shrink-0">
              <Papicon icon="smile" size={18} />
            </div>
            <div>
              <p class="text-sm font-semibold text-on-surface">{m.e1_tickets_sec_satisfaction_title()}</p>
              <p class="text-[10px] text-on-surface-variant/60 mt-0.5">{m.e1_tickets_sec_satisfaction_desc()}</p>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            {#if ticketSatisfactionCommentEnabled || ticketSatisfactionLogChannelId}
              <span class="px-2 py-0.5 rounded-full text-[9px] font-semibold uppercase bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">{m.e1_tickets_active_badge()}</span>
            {/if}
            <Papicon icon={expandedConfigSection === 'satisfaction' ? 'chevron-up' : 'chevron-down'} size={16} class="text-on-surface-variant/40" />
          </div>
        </button>
        {#if expandedConfigSection === 'satisfaction'}
          <div class="px-4 lg:px-5 pb-5 space-y-4 border-t border-outline-variant/10 pt-4">
            <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
              <input type="checkbox" bind:checked={ticketSatisfactionCommentEnabled} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
              <div>
                <span class="text-xs font-bold text-on-surface">{m.e1_tickets_sat_comment_enable()}</span>
                <p class="text-[10px] text-on-surface-variant/60">{m.e1_tickets_sat_comment_enable_desc()}</p>
              </div>
            </label>
            {#if ticketSatisfactionCommentEnabled}
              <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <label class="block sm:col-span-2">
                  <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_sat_comment_question_label()}</span>
                  <FormInput type="text" bind:value={ticketSatisfactionCommentQuestion} placeholder={m.e1_tickets_sat_comment_question_ph()} className="w-full" />
                </label>
                <label class="block">
                  <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_sat_comment_timeout_label()}</span>
                  <input type="number" bind:value={ticketSatisfactionCommentTimeout} min={30} max={900} step={10} class="w-full bg-surface-container-high text-sm px-4 py-2.5 rounded-xl border border-outline-variant/10 focus:ring-1 ring-primary/30 transition-all outline-none" />
                </label>
              </div>
              <p class="text-[10px] text-on-surface-variant/50 ml-1">{m.e1_tickets_sat_comment_hint()}</p>
            {/if}

            <div class="pt-2 border-t border-outline-variant/10 space-y-4">
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_sat_log_label()}</span>
                <SearchableSelect bind:value={ticketSatisfactionLogChannelId} options={discordChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))} placeholder={m.e1_tickets_select_ph()} className="w-full" />
                {#if isMissingReference(ticketSatisfactionLogChannelId, discordChannels)}
                  <p class="text-[10px] text-amber-500 mt-1.5">{m.e1_tickets_missing_ref()}</p>
                {/if}
                <p class="text-[10px] text-on-surface-variant/50 ml-1 mt-1.5">{m.e1_tickets_sat_log_desc()}</p>
              </label>
              {#if ticketSatisfactionLogChannelId}
                <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
                  <input type="checkbox" bind:checked={ticketSatisfactionLogAnonymous} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
                  <div>
                    <span class="text-xs font-bold text-on-surface">{m.e1_tickets_sat_log_anonymous()}</span>
                    <p class="text-[10px] text-on-surface-variant/60">{m.e1_tickets_sat_log_anonymous_desc()}</p>
                  </div>
                </label>
              {/if}
            </div>
          </div>
        {/if}
      </div>

      <!-- ─── Section 2: Types de tickets ────────────────────────────────── -->
      <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 overflow-hidden">
        <button onclick={() => toggleConfigSection('types')} class="w-full flex items-center justify-between p-4 lg:p-5 hover:bg-white/3 transition-colors text-left">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-lg bg-rose-500/10 text-rose-400 flex items-center justify-center shrink-0">
              <Papicon icon="layers" size={18} />
            </div>
            <div>
              <p class="text-sm font-semibold text-on-surface">{m.e1_tickets_sec_types_title()}</p>
              <p class="text-[10px] text-on-surface-variant/60 mt-0.5">{m.e1_tickets_sec_types_desc({ count: ticketTypes.length })}</p>
            </div>
          </div>
          <Papicon icon={expandedConfigSection === 'types' ? 'chevron-up' : 'chevron-down'} size={16} class="text-on-surface-variant/40 shrink-0" />
        </button>
        {#if expandedConfigSection === 'types'}
          <div class="px-4 lg:px-5 pb-5 border-t border-outline-variant/10 pt-4 space-y-4">
            <div class="flex justify-end">
              <button onclick={addTicketType}
                class="px-3 py-2 bg-primary text-white rounded-lg text-[10px] font-semibold uppercase tracking-wider active:scale-[0.98] transition-transform flex items-center gap-1.5"
              >
                <Papicon icon="plus" size={13} /> {m.e1_tickets_add_type()}
              </button>
            </div>

            <div class="space-y-3">
              {#each ticketTypes as ticketType, index}
                {@const isExpanded = expandedTicketTypeIndex === index}
                <div class="rounded-xl border transition-all {isExpanded ? 'border-primary/40 bg-surface-container/35 shadow-sm' : 'border-outline-variant/10 bg-surface-container/15 hover:border-outline-variant/20'}">
                  
                  <!-- Accordion Header -->
                  <div class="flex flex-col sm:flex-row items-stretch sm:items-center justify-between p-3.5 gap-3">
                    <button
                      onclick={() => expandedTicketTypeIndex = isExpanded ? null : index}
                      class="flex-1 flex flex-wrap items-center gap-2.5 text-left outline-none"
                    >
                      <span class="text-lg shrink-0">{ticketType.emoji || '📩'}</span>
                      <div class="min-w-0 flex-1">
                        <span class="text-sm font-semibold text-on-surface block truncate">{ticketType.label || `Type #${index + 1}`}</span>
                        
                        <!-- Badges summary of configuration -->
                        <div class="flex flex-wrap items-center gap-1.5 mt-1">
                          <!-- Mode badge -->
                          {#if ticketType.mode === 'CHANNEL'}
                            <span class="px-1.5 py-0.5 rounded text-[8px] font-semibold tracking-wider uppercase bg-blue-500/10 text-blue-400 border border-blue-500/15">{m.e1_tickets_badge_channel()}</span>
                          {:else if ticketType.mode === 'DM'}
                            <span class="px-1.5 py-0.5 rounded text-[8px] font-semibold tracking-wider uppercase bg-purple-500/10 text-purple-400 border border-purple-500/15">{m.e1_tickets_badge_dm()}</span>
                          {:else if ticketType.mode === 'THREAD'}
                            <span class="px-1.5 py-0.5 rounded text-[8px] font-semibold tracking-wider uppercase bg-amber-500/10 text-amber-400 border border-amber-500/15">{m.e1_tickets_badge_thread()}</span>
                          {:else}
                            <span class="px-1.5 py-0.5 rounded text-[8px] font-semibold tracking-wider uppercase bg-surface-container-high text-on-surface-variant/60 border border-outline-variant/10">{m.e1_tickets_badge_global_mode()}</span>
                          {/if}

                          <!-- Staff Role Badge -->
                          {#if ticketType.staffRoleId}
                            {@const role = discordRoles.find(r => r.id === ticketType.staffRoleId)}
                            <span class="px-1.5 py-0.5 rounded text-[8px] font-semibold tracking-wider bg-emerald-500/10 text-emerald-400 border border-emerald-500/15">Staff: @{role?.name || m.e1_tickets_unknown_role()}</span>
                          {:else}
                            <span class="px-1.5 py-0.5 rounded text-[8px] font-semibold tracking-wider bg-surface-container-high text-on-surface-variant/40 border border-outline-variant/10">{m.e1_tickets_badge_inherited_staff()}</span>
                          {/if}

                          <!-- Form Enabled Badge -->
                          {#if ticketType.formEnabled}
                            <span class="px-1.5 py-0.5 rounded text-[8px] font-semibold tracking-wider bg-indigo-500/10 text-indigo-400 border border-indigo-500/15">{m.e1_tickets_badge_form_with_questions({ count: (ticketType.formCustomFields || []).length })}</span>
                          {:else}
                            <span class="px-1.5 py-0.5 rounded text-[8px] font-semibold tracking-wider bg-surface-container-high text-on-surface-variant/40 border border-outline-variant/10">{m.e1_tickets_badge_direct_creation()}</span>
                          {/if}
                        </div>
                      </div>
                    </button>

                    <!-- Reorder & Delete actions in header -->
                    <div class="flex items-center gap-1.5 self-end sm:self-center shrink-0">
                      <!-- Reordering buttons -->
                      <button
                        onclick={() => moveTicketType(index, 'UP')}
                        disabled={index === 0}
                        class="p-1.5 rounded-lg border border-outline-variant/10 text-on-surface-variant hover:bg-white/5 disabled:opacity-30 transition-colors"
                        title={m.e1_tickets_move_up()}
                      >
                        <Papicon icon="arrow-up" size={13} />
                      </button>
                      <button
                        onclick={() => moveTicketType(index, 'DOWN')}
                        disabled={index === ticketTypes.length - 1}
                        class="p-1.5 rounded-lg border border-outline-variant/10 text-on-surface-variant hover:bg-white/5 disabled:opacity-30 transition-colors"
                        title={m.e1_tickets_move_down()}
                      >
                        <Papicon icon="arrow-down" size={13} />
                      </button>

                      <div class="w-px h-5 bg-outline-variant/10 mx-1"></div>

                      <!-- Edit expansion toggle button -->
                      <button
                        onclick={() => expandedTicketTypeIndex = isExpanded ? null : index}
                        class="px-2.5 py-1.5 rounded-lg border text-[9px] font-semibold uppercase tracking-wider transition-colors {isExpanded ? 'bg-primary text-white border-primary' : 'bg-surface-container text-on-surface hover:bg-white/5 border-outline-variant/10'}"
                      >
                        {isExpanded ? m.e1_tickets_type_collapse() : m.e1_tickets_type_edit()}
                      </button>

                      <!-- Delete button -->
                      <button
                        onclick={() => removeTicketType(index)}
                        class="p-1.5 rounded-lg bg-rose-500/10 text-rose-500 hover:bg-rose-500 hover:text-white border border-rose-500/15 transition-all"
                        title={m.e1_tickets_type_delete()}
                      >
                        <Papicon icon="trash-2" size={13} />
                      </button>
                    </div>
                  </div>

                  <!-- Accordion Content -->
                  {#if isExpanded}
                    <div class="px-4 pb-4 pt-3 border-t border-outline-variant/10 bg-surface-container-low/10 space-y-4 animate-fade-in">
                      
                      <!-- Button label, emoji, style select -->
                      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <label class="block">
                          <span class="text-[10px] font-bold text-on-surface-variant/70 ml-1 mb-1.5 block">{m.e1_tickets_type_label()}</span>
                          <FormInput type="text" bind:value={ticketType.label} placeholder={m.e1_tickets_type_label_ph()} className="w-full" />
                        </label>
                        <div class="grid grid-cols-2 gap-3">
                          <label class="block">
                            <span class="text-[10px] font-bold text-on-surface-variant/70 ml-1 mb-1.5 block">{m.e1_tickets_type_emoji()}</span>
                            <div class="flex gap-1.5">
                              <FormInput type="text" bind:value={ticketType.emoji} placeholder="📩" className="w-full" />
                              <EmojiPicker bind:value={ticketType.emoji} />
                            </div>
                          </label>
                          <label class="block">
                            <span class="text-[10px] font-bold text-on-surface-variant/70 ml-1 mb-1.5 block">{m.e1_tickets_type_style()}</span>
                            <FormSelect bind:value={ticketType.buttonStyle} className="w-full">
                              <option value="PRIMARY">{m.e1_tickets_style_primary()}</option>
                              <option value="SECONDARY">{m.e1_tickets_style_secondary()}</option>
                              <option value="SUCCESS">{m.e1_tickets_style_success()}</option>
                              <option value="DANGER">{m.e1_tickets_style_danger()}</option>
                            </FormSelect>
                          </label>
                        </div>
                      </div>

                      <label class="block">
                        <span class="text-[10px] font-bold text-on-surface-variant/70 ml-1 mb-1.5 block">{m.e1_tickets_type_desc()}</span>
                        <FormTextarea bind:value={ticketType.description} placeholder={m.e1_tickets_type_desc_ph()} className="w-full h-16" />
                      </label>

                      <!-- Salons & Rôles targets -->
                      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <label class="block">
                          <span class="text-[10px] font-bold text-on-surface-variant/70 ml-1 mb-1.5 block">{m.e1_tickets_type_mode()}</span>
                          <FormSelect bind:value={ticketType.mode} className="w-full">
                            <option value="">{m.e1_tickets_mode_default()}</option>
                            <option value="CHANNEL">{m.e1_tickets_mode_channel_opt()}</option>
                            <option value="DM">{m.e1_tickets_mode_dm_opt()}</option>
                            <option value="THREAD">{m.e1_tickets_mode_thread_opt()}</option>
                          </FormSelect>
                        </label>
                        <label class="block">
                          <span class="text-[10px] font-bold text-on-surface-variant/70 ml-1 mb-1.5 block">{m.e1_tickets_type_category()}</span>
                          <SearchableSelect bind:value={ticketType.categoryId} options={discordCategories.map(c => ({ id: c.id, name: c.name }))} placeholder={m.e1_tickets_inherited_ph()} className="w-full" />
                          {#if isMissingReference(ticketType.categoryId, discordCategories)}
                            <p class="text-[10px] text-amber-500 mt-1.5">{m.e1_tickets_missing_ref()}</p>
                          {/if}
                        </label>
                        <label class="block">
                          <span class="text-[10px] font-bold text-on-surface-variant/70 ml-1 mb-1.5 block">{m.e1_tickets_type_staff_role()}</span>
                          <SearchableSelect bind:value={ticketType.staffRoleId} options={discordRoles.map(r => ({ id: r.id, name: `@${r.name}` }))} placeholder={m.e1_tickets_inherited_ph()} className="w-full" />
                          {#if isMissingReference(ticketType.staffRoleId, discordRoles)}
                            <p class="text-[10px] text-amber-500 mt-1.5">{m.e1_tickets_missing_ref()}</p>
                          {/if}
                        </label>
                      </div>

                      <!-- Surcharges validation / verrouillage propres au type -->
                      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <label class="block">
                          <span class="text-[10px] font-bold text-on-surface-variant/70 ml-1 mb-1.5 block">{m.e1_tickets_type_lock_until_claim()}</span>
                          <FormSelect bind:value={ticketType.lockUntilClaim} className="w-full">
                            <option value="">{m.e1_tickets_type_inherit({ value: ticketLockUntilClaim ? m.e1_tickets_type_enabled() : m.e1_tickets_type_disabled() })}</option>
                            <option value="YES">{m.e1_tickets_type_enabled()}</option>
                            <option value="NO">{m.e1_tickets_type_disabled()}</option>
                          </FormSelect>
                        </label>
                        <label class="block">
                          <span class="text-[10px] font-bold text-on-surface-variant/70 ml-1 mb-1.5 block">{m.e1_tickets_type_require_approval()}</span>
                          <FormSelect bind:value={ticketType.requireApproval} className="w-full">
                            <option value="">{m.e1_tickets_type_inherit({ value: ticketApprovalEnabled ? m.e1_tickets_type_enabled() : m.e1_tickets_type_disabled() })}</option>
                            <option value="YES">{m.e1_tickets_type_enabled()}</option>
                            <option value="NO">{m.e1_tickets_type_disabled()}</option>
                          </FormSelect>
                        </label>
                      </div>

                      <!-- Toggle Options -->
                      {#if ticketType.mode === 'DM' || (ticketType.mode === '' && ticketMode === 'DM')}
                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                          <div class="flex items-center gap-2.5 p-1">
                            <ToggleSwitch checked={ticketType.anonymous} onToggle={(v) => { ticketType.anonymous = v; }} size="sm" />
                            <div>
                              <span class="text-xs font-semibold text-on-surface">{m.e1_tickets_staff_anonymity()}</span>
                              <p class="text-[10px] text-on-surface-variant/50 leading-none mt-0.5">{m.e1_tickets_staff_anonymity_desc()}</p>
                            </div>
                          </div>
                          <div class="flex items-center gap-2.5 p-1">
                            <ToggleSwitch checked={ticketType.staffServerRelay} onToggle={(v) => { ticketType.staffServerRelay = v; }} size="sm" />
                            <div>
                              <span class="text-xs font-semibold text-on-surface">{m.e1_tickets_thread_on_staff_server()}</span>
                              <p class="text-[10px] text-on-surface-variant/50 leading-none mt-0.5">{m.e1_tickets_thread_on_staff_server_desc()}</p>
                            </div>
                          </div>
                        </div>
                      {/if}

                      <!-- Ticket interne sur le serveur staff (mode CHANNEL uniquement) -->
                      {#if staffServerInfo.staffGuildId && (ticketType.mode === 'CHANNEL' || (ticketType.mode === '' && ticketMode === 'CHANNEL'))}
                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                          <div class="flex items-center gap-2.5 p-1">
                            <ToggleSwitch checked={ticketType.staffServerChannel} onToggle={(v) => { ticketType.staffServerChannel = v; }} size="sm" />
                            <div>
                              <span class="text-xs font-semibold text-on-surface">{m.e1_tickets_channel_on_staff_server()}</span>
                              <p class="text-[10px] text-on-surface-variant/50 leading-none mt-0.5">{m.e1_tickets_channel_on_staff_server_desc({ name: staffServerInfo.staffGuildName ?? "" })}</p>
                            </div>
                          </div>
                          {#if ticketType.staffServerChannel}
                            <label class="block">
                              <span class="text-[10px] font-bold text-on-surface-variant/70 ml-1 mb-1.5 block">{m.e1_tickets_staff_server_category()}</span>
                              <SearchableSelect bind:value={ticketType.staffServerCategoryId} options={staffServerInfo.categories.map((c: any) => ({ id: c.id, name: c.name }))} placeholder={m.e1_tickets_select_category_ph()} className="w-full" />
                              {#if isMissingReference(ticketType.staffServerCategoryId, staffServerInfo.categories)}
                                <p class="text-[10px] text-amber-500 mt-1.5">{m.e1_tickets_missing_ref()}</p>
                              {/if}
                            </label>
                          {/if}
                        </div>
                      {/if}

                      <!-- Modal Form Configurator -->
                      <div class="pt-4 border-t border-outline-variant/10 mt-3">
                        <label class="flex items-center gap-3 cursor-pointer p-1 rounded-xl transition-colors">
                          <input type="checkbox" bind:checked={ticketType.formEnabled} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
                          <div>
                            <span class="text-xs font-bold text-on-surface">{m.e1_tickets_enable_form()}</span>
                            <p class="text-[10px] text-on-surface-variant/60">{m.e1_tickets_enable_form_desc()}</p>
                          </div>
                        </label>

                        {#if ticketType.formEnabled}
                          <div class="space-y-4 pt-4 pl-7">
                            <div class="flex items-center justify-between">
                              <span class="text-xs font-bold text-on-surface-variant/80">{m.e1_tickets_custom_questions()}</span>
                              <button
                                onclick={() => addCustomField(index)}
                                disabled={(ticketType.formCustomFields || []).length >= 5}
                                class="px-2 py-1 bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-40 rounded-lg text-[9px] font-semibold uppercase tracking-wider transition-colors flex items-center gap-1"
                              >
                                <Papicon icon="plus" size={11} /> {m.e1_tickets_add_question()}
                              </button>
                            </div>

                            {#if !(ticketType.formCustomFields || []).length}
                              <div class="p-4 rounded-xl border border-dashed border-outline-variant/20 bg-surface-container/10 text-center">
                                <p class="text-xs text-on-surface-variant/60">{m.e1_tickets_no_question()}</p>
                                <p class="text-[10px] text-on-surface-variant/40 mt-1">{m.e1_tickets_no_question_hint()}</p>
                              </div>
                            {:else}
                              <div class="space-y-3">
                                {#each ticketType.formCustomFields as field, fieldIndex}
                                  <div class="p-3 rounded-lg border border-outline-variant/10 bg-surface-container/10 space-y-3 relative group">
                                    <div class="flex items-center justify-between">
                                      <span class="text-[10px] font-bold text-primary">{m.e1_tickets_question_number({ index: fieldIndex + 1 })}</span>
                                      <button
                                        onclick={() => removeCustomField(index, field.id)}
                                        class="text-rose-500 hover:text-rose-400 p-1 rounded-lg hover:bg-rose-500/10 transition-colors"
                                      >
                                        <Papicon icon="trash-2" size={13} />
                                      </button>
                                    </div>

                                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                      <label class="block">
                                        <span class="text-[9px] font-bold text-on-surface-variant/70 mb-1 block">{m.e1_tickets_field_question()}</span>
                                        <FormInput type="text" bind:value={field.label} placeholder={m.e1_tickets_field_question_ph()} className="w-full" />
                                      </label>
                                      <label class="block">
                                        <span class="text-[9px] font-bold text-on-surface-variant/70 mb-1 block">{m.e1_tickets_field_hint()}</span>
                                        <FormInput type="text" bind:value={field.placeholder} placeholder={m.e1_tickets_field_hint_ph()} className="w-full" />
                                      </label>
                                    </div>

                                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                      <label class="block">
                                        <span class="text-[9px] font-bold text-on-surface-variant/70 mb-1 block">{m.e1_tickets_answer_type()}</span>
                                        <FormSelect bind:value={field.style} className="w-full">
                                          <option value="SHORT">{m.e1_tickets_answer_short()}</option>
                                          <option value="PARAGRAPH">{m.e1_tickets_answer_paragraph()}</option>
                                          <option value="SELECT">{m.e1_tickets_answer_select()}</option>
                                          <option value="RADIO">{m.e1_tickets_answer_radio()}</option>
                                          <option value="FILE">{m.e1_tickets_answer_file()}</option>
                                        </FormSelect>
                                      </label>
                                      <label class="flex items-center gap-2 cursor-pointer pt-5">
                                        <input type="checkbox" bind:checked={field.required} class="w-3.5 h-3.5 rounded text-primary focus:ring-primary border-outline-variant/30" />
                                        <span class="text-[9px] font-bold text-on-surface">{m.e1_tickets_field_required()}</span>
                                      </label>
                                    </div>

                                    {#if field.style === 'SELECT' || field.style === 'RADIO'}
                                      <div class="pt-1">
                                        <label class="block">
                                          <span class="text-[9px] font-bold text-on-surface-variant/70 mb-1 block">{m.e1_tickets_field_choices()}</span>
                                          <FormInput
                                            type="text"
                                            bind:value={field.choicesString}
                                            placeholder={m.e1_tickets_field_choices_ph()}
                                            className="w-full"
                                          />
                                        </label>
                                        {#if field.style === 'RADIO'}
                                          <p class="text-[9px] text-on-surface-variant/40 mt-1">{m.e1_tickets_field_choices_radio_hint()}</p>
                                        {/if}
                                      </div>
                                    {/if}

                                    {#if field.style === 'SELECT' || field.style === 'RADIO' || field.style === 'FILE'}
                                      <p class="text-[9px] text-primary/70 leading-snug">{m.e1_tickets_field_interactive_hint()}</p>
                                    {/if}
                                  </div>
                                {/each}
                              </div>
                            {/if}
                          </div>
                        {/if}
                      </div>

                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </div>

    </div>
    {/await}
  {:else if activeTab === 'transcripts'}
    <div class="bg-surface-container-low/40 border border-outline-variant/10 rounded-xl p-4 lg:p-6 flex flex-col min-h-[40vh]">
      <div class="mb-4">
        <h3 class="text-lg font-semibold text-on-surface">{m.e1_tickets_transcripts_title()}</h3>
        <p class="text-on-surface-variant text-xs mt-0.5">{m.e1_tickets_transcripts_desc()}</p>
      </div>

      {#if loading}
        <div class="flex items-center justify-center py-16">
          <div class="w-8 h-8 rounded-full border-4 border-primary border-t-transparent animate-spin"></div>
        </div>
      {:else if transcripts.length === 0}
        <div class="flex flex-col items-center justify-center py-16 text-on-surface-variant/30">
          <Papicon icon="inbox" size={36} class="opacity-50 mb-2" />
          <p class="text-xs font-bold">{m.e1_tickets_transcripts_empty()}</p>
        </div>
      {:else}
        <!-- Mobile: card layout / Desktop: table -->
        <div class="hidden md:block overflow-x-auto w-full">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-outline-variant/15 text-xs font-medium text-on-surface-variant/70">
                <th class="py-3 px-4">{m.e1_tickets_th_channel()}</th>
                <th class="py-3 px-4">{m.e1_tickets_th_type()}</th>
                <th class="py-3 px-4">{m.e1_tickets_th_period()}</th>
                <th class="py-3 px-4">{m.e1_tickets_th_generated()}</th>
                <th class="py-3 px-4 text-right">{m.e1_tickets_th_action()}</th>
              </tr>
            </thead>
            <tbody>
              {#each transcripts as t}
                <tr class="border-b border-outline-variant/10 hover:bg-white/5 transition-colors">
                  <td class="py-3 px-4 font-mono text-sm font-bold text-on-surface">
                    <span class="text-primary/70">#</span>{t.channelName}
                  </td>
                  <td class="py-3 px-4">
                    {#if t.channelName.startsWith('ticket-') || t.channelName.startsWith('fermer-')}
                      <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase bg-blue-500/10 text-blue-400 border border-blue-500/20">{m.e1_tickets_badge_ticket()}</span>
                    {:else}
                      <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">/transcript</span>
                    {/if}
                  </td>
                  <td class="py-3 px-4 text-xs text-on-surface-variant">
                    {#if t.startTime && t.endTime}
                      {new Date(t.startTime).toLocaleDateString(dateLocale())} - {new Date(t.endTime).toLocaleDateString(dateLocale())}
                    {:else}
                      <span class="text-on-surface-variant/40 italic">{m.e1_tickets_period_all()}</span>
                    {/if}
                  </td>
                  <td class="py-3 px-4 text-xs text-on-surface-variant">
                    {new Date(t.createdAt).toLocaleDateString(dateLocale())}
                  </td>
                  <td class="py-3 px-4 text-right">
                    <a href="/transcripts/{t.id}" target="_blank"
                      class="px-3 py-1.5 bg-primary/10 text-primary border border-primary/20 rounded-lg text-[10px] font-semibold uppercase tracking-wider hover:bg-primary hover:text-white transition-all inline-flex items-center gap-1"
                    >
                      <Papicon icon="external-link" size={11} /> Voir
                    </a>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>

        <!-- Mobile cards -->
        <div class="md:hidden space-y-3">
          {#each transcripts as t}
            <div class="rounded-xl border border-outline-variant/10 bg-surface-container/20 p-3.5">
              <div class="flex items-center justify-between gap-2 mb-2">
                <span class="font-mono text-sm font-bold text-on-surface truncate"><span class="text-primary/70">#</span>{t.channelName}</span>
                {#if t.channelName.startsWith('ticket-') || t.channelName.startsWith('fermer-')}
                  <span class="px-2 py-0.5 rounded-full text-[9px] font-semibold uppercase bg-blue-500/10 text-blue-400 border border-blue-500/20 shrink-0">{m.e1_tickets_badge_ticket()}</span>
                {:else}
                  <span class="px-2 py-0.5 rounded-full text-[9px] font-semibold uppercase bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">/transcript</span>
                {/if}
              </div>
              <p class="text-[10px] text-on-surface-variant/60 mb-2">
                {new Date(t.createdAt).toLocaleDateString(dateLocale())}
                {#if t.startTime && t.endTime}
                  - Du {new Date(t.startTime).toLocaleDateString(dateLocale())} au {new Date(t.endTime).toLocaleDateString(dateLocale())}
                {/if}
              </p>
              <a href="/transcripts/{t.id}" target="_blank"
                class="px-3 py-1.5 bg-primary/10 text-primary border border-primary/20 rounded-lg text-[10px] font-semibold uppercase tracking-wider hover:bg-primary hover:text-white transition-all inline-flex items-center gap-1"
              >
                <Papicon icon="external-link" size={11} /> {m.e1_tickets_view_btn()}
              </a>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {:else if activeTab === 'satisfaction'}
    <!-- Satisfaction Tab -->
    {#if satisfactionLoading}
      <div class="flex items-center justify-center py-16">
        <div class="w-8 h-8 rounded-full border-4 border-primary border-t-transparent animate-spin"></div>
      </div>
    {:else if satisfactionData}
      <div class="sat-grid">
        <!-- Overview Card -->
        <div class="sat-card sat-overview-card">
          <div class="sat-avg-rating" style="color: {getRatingColor(satisfactionData.global.averageRating)}">
            <span class="sat-avg-value">{satisfactionData.global.averageRating.toFixed(1)}</span>
            <span class="sat-avg-max">/5</span>
          </div>
          <p class="sat-avg-label">{m.e1_tickets_sat_responses({ count: satisfactionData.global.totalResponses })}</p>

          <div class="sat-distribution">
            {#each satisfactionData.global.distribution as d}
              <div class="sat-dist-row">
                <span class="sat-dist-label">{ratingEmojis[d.rating]} {d.rating}</span>
                <div class="sat-dist-bar">
                  <div class="sat-dist-fill" style="width: {satisfactionData.global.totalResponses > 0 ? (d.count / satisfactionData.global.totalResponses * 100) : 0}%"></div>
                </div>
                <span class="sat-dist-count">{d.count}</span>
              </div>
            {/each}
          </div>
        </div>

        <!-- Staff Satisfaction Card -->
        <div class="sat-card sat-staff-card">
          <h3 class="sat-card-title">{m.e1_tickets_sat_by_staff()}</h3>
          {#if satisfactionData.byStaff.length === 0}
            <p class="sat-empty">{m.e1_tickets_sat_no_staff_data()}</p>
          {:else}
            <div class="sat-staff-list">
              {#each satisfactionData.byStaff as staff}
                {@const isExpanded = expandedStaffId === staff.staffId}
                {@const commentCount = staff.commentCount ?? 0}
                {@const previews = staff.recentComments ?? []}
                <div class="sat-staff-item">
                  <div class="sat-staff-row">
                    <button type="button" class="sat-person-main sat-clickable-person" onclick={() => openSatisfactionMember(staff.staffId, staff.staff)}>
                      {#if staff.staff?.avatarUrl}
                        <img src={staff.staff.avatarUrl} alt="" class="sat-person-avatar" />
                      {:else}
                        <span class="sat-person-avatar sat-avatar-fallback">{getSatisfactionInitials(staff.staff, staff.staffId)}</span>
                      {/if}
                      <span class="sat-person-text">
                        <span class="sat-person-name">{getSatisfactionPersonName(staff.staff, staff.staffId)}</span>
                        <span class="sat-person-handle">{getSatisfactionPersonHandle(staff.staff, staff.staffId)}</span>
                      </span>
                    </button>
                    <div class="sat-staff-rating" style="color: {getRatingColor(staff.averageRating)}">
                      {staff.averageRating.toFixed(1)}/5
                    </div>
                    <span class="sat-staff-count">{m.e1_tickets_sat_reviews_count({ count: staff.totalResponses })}</span>
                    <div class="sat-staff-actions">
                      <button
                        type="button"
                        class="sat-staff-chip"
                        class:sat-staff-chip-muted={commentCount === 0}
                        disabled={commentCount === 0}
                        aria-expanded={isExpanded}
                        title={commentCount === 0 ? m.e1_tickets_sat_no_comment() : m.e1_tickets_sat_comments_count({ count: commentCount })}
                        onclick={() => toggleStaffComments(staff.staffId)}
                      >
                        <Papicon icon="message-square" size={13} />
                        <span>{commentCount}</span>
                        {#if commentCount > 0}
                          <Papicon icon={isExpanded ? 'chevron-up' : 'chevron-down'} size={13} />
                        {/if}
                      </button>
                      <button type="button" class="sat-staff-chip" onclick={() => openStaffReviews(staff.staffId, staff.staff)}>
                        {m.e1_tickets_sat_view_all()}
                      </button>
                    </div>
                  </div>

                  {#if isExpanded}
                    <div class="sat-comment-list">
                      {#each previews as review}
                        <div class="sat-comment">
                          <div class="sat-comment-head">
                            <span class="sat-comment-emoji">{ratingEmojis[review.rating]}</span>
                            <button type="button" class="sat-comment-author sat-clickable-person" onclick={() => openSatisfactionMember(review.userId, review.user)}>
                              {getSatisfactionPersonName(review.user, review.userId)}
                            </button>
                            <span class="sat-comment-date">{new Date(review.createdAt).toLocaleDateString(dateLocale())}</span>
                          </div>
                          <p class="sat-comment-body">{review.comment}</p>
                        </div>
                      {/each}
                      {#if commentCount > previews.length}
                        <button type="button" class="sat-comment-more" onclick={() => openStaffReviews(staff.staffId, staff.staff)}>
                          {m.e1_tickets_sat_more_comments({ count: commentCount - previews.length })}
                        </button>
                      {/if}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>

        <!-- Recent Reviews Card -->
        <div class="sat-card sat-recent-card">
          <h3 class="sat-card-title">{m.e1_tickets_sat_recent()}</h3>
          {#if satisfactionData.global.recent.length === 0}
            <p class="sat-empty">{m.e1_tickets_sat_no_review()}</p>
          {:else}
            <div class="sat-recent-list">
              {#each satisfactionData.global.recent.slice(0, 15) as review}
                <div class="sat-review-item">
                  <div class="sat-review-row">
                    <span class="sat-review-emoji">{ratingEmojis[review.rating]}</span>
                    <button type="button" class="sat-review-user sat-clickable-person" onclick={() => openSatisfactionMember(review.userId, review.user)}>
                      {#if review.user?.avatarUrl}
                        <img src={review.user.avatarUrl} alt="" class="sat-person-avatar" />
                      {:else}
                        <span class="sat-person-avatar sat-avatar-fallback">{getSatisfactionInitials(review.user, review.userId)}</span>
                      {/if}
                      <span class="sat-person-text">
                        <span class="sat-person-name">{getSatisfactionPersonName(review.user, review.userId)}</span>
                        <span class="sat-person-handle">{getSatisfactionPersonHandle(review.user, review.userId)}</span>
                      </span>
                    </button>
                    {#if review.staff}
                      <span class="sat-review-staff">{m.e1_tickets_sat_handled_by({ name: getSatisfactionPersonName(review.staff, review.staffId) })}</span>
                    {/if}
                    <span class="sat-review-date">{new Date(review.createdAt).toLocaleDateString(dateLocale())}</span>
                  </div>
                  {#if review.comment}
                    <p class="sat-review-comment">{review.comment}</p>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    {:else}
      <div class="flex flex-col items-center justify-center py-16 text-on-surface-variant/30">
        <Papicon icon="smile" size={36} class="opacity-50 mb-2" />
        <p class="text-xs font-bold">{m.e1_tickets_sat_empty()}</p>
      </div>
    {/if}
  {:else if activeTab === 'macros'}
    <div class="max-w-4xl mx-auto space-y-4">
      <div class="flex items-start justify-between gap-4 pb-2">
        <div>
          <h3 class="text-lg font-semibold text-on-surface">Macros</h3>
          <p class="text-on-surface-variant text-xs mt-0.5">
            Réponses pré-écrites que le staff insère depuis le bouton « Macros » d'un ticket.
            Variables disponibles : <code class="px-1 rounded bg-surface-container">{'{user}'}</code>,
            <code class="px-1 rounded bg-surface-container">{'{staff}'}</code>,
            <code class="px-1 rounded bg-surface-container">{'{ticket_id}'}</code>,
            <code class="px-1 rounded bg-surface-container">{'{ticket_type}'}</code>,
            <code class="px-1 rounded bg-surface-container">{'{server}'}</code>.
          </p>
        </div>
        <ActionButton variant="primary" icon="plus" label="Nouvelle macro" onclick={openNewMacro} />
      </div>

      {#if macrosLoading}
        <Skeleton className="h-24 w-full" />
      {:else if macros.length === 0}
        <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 p-8 text-center">
          <Papicon icon="zap" size={28} class="text-on-surface-variant/40 mx-auto mb-2" />
          <p class="text-sm font-semibold text-on-surface">Aucune macro</p>
          <p class="text-xs text-on-surface-variant/70 mt-1">
            Créez vos réponses récurrentes : le staff les enverra en deux clics, avec les actions qui vont avec.
          </p>
        </div>
      {:else}
        <div class="space-y-2">
          {#each macros as macro (macro.id)}
            <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 p-4">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2 flex-wrap">
                    {#if macro.emoji}<span class="text-sm">{macro.emoji}</span>{/if}
                    <span class="text-sm font-semibold text-on-surface">{macro.name}</span>
                    {#if macro.category}
                      <span class="text-[10px] px-1.5 py-0.5 rounded bg-surface-container text-on-surface-variant">{macro.category}</span>
                    {/if}
                    {#if !macro.enabled}
                      <span class="text-[10px] px-1.5 py-0.5 rounded bg-error/10 text-error">désactivée</span>
                    {/if}
                    {#if macro.autoSendOnOpen}
                      <span class="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400">auto à l'ouverture</span>
                    {/if}
                  </div>
                  <p class="text-xs text-on-surface-variant/80 mt-1.5 line-clamp-2 whitespace-pre-wrap">{macro.content}</p>
                  <div class="flex items-center gap-3 mt-2 text-[10px] text-on-surface-variant/60">
                    <span>{macro.usageCount} utilisation{macro.usageCount > 1 ? 's' : ''}</span>
                    {#if macro.keywords?.length}
                      <span>· mots-clés : {macro.keywords.join(', ')}</span>
                    {/if}
                    {#if macroActionSummary(macro)}
                      <span>· {macroActionSummary(macro)}</span>
                    {/if}
                  </div>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    class="p-2 rounded-lg hover:bg-white/5 text-on-surface-variant/70 hover:text-on-surface transition-colors"
                    title="Modifier"
                    onclick={() => openEditMacro(macro)}
                  >
                    <Papicon icon="pencil" size={15} />
                  </button>
                  <button
                    type="button"
                    class="p-2 rounded-lg hover:bg-error/10 text-on-surface-variant/70 hover:text-error transition-colors"
                    title="Supprimer"
                    onclick={() => deleteMacro(macro)}
                  >
                    <Papicon icon="trash" size={15} />
                  </button>
                </div>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {:else if activeTab === 'blacklist'}
    <div class="max-w-4xl mx-auto space-y-4">
      <div class="pb-2">
        <h3 class="text-lg font-semibold text-on-surface">{m.e1_tickets_bl_title()}</h3>
        <p class="text-on-surface-variant text-xs mt-0.5">{m.e1_tickets_bl_desc()}</p>
      </div>

      <!-- Ajout d'une interdiction -->
      <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 p-4 lg:p-5 space-y-4">
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label class="block">
            <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_bl_user_id()}</span>
            <FormInput type="text" bind:value={blacklistUserId} placeholder="123456789012345678" className="w-full" />
          </label>
          <label class="block">
            <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_bl_duration()}</span>
            <FormInput type="text" bind:value={blacklistDurationDays} placeholder={m.e1_tickets_bl_duration_ph()} className="w-full" />
          </label>
          <label class="block">
            <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_bl_reason()}</span>
            <FormInput type="text" bind:value={blacklistReason} placeholder={m.e1_tickets_bl_reason_ph()} className="w-full" />
          </label>
        </div>
        <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
          <input type="checkbox" bind:checked={blacklistAllowReopen} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
          <div>
            <span class="text-xs font-bold text-on-surface">{m.e1_tickets_bl_allow_reopen()}</span>
            <p class="text-[10px] text-on-surface-variant/60">{m.e1_tickets_bl_allow_reopen_desc()}</p>
          </div>
        </label>
        <div class="flex justify-end">
          <button
            onclick={addToBlacklist}
            disabled={blacklistAddAction.state.loading || !blacklistUserId.trim()}
            class="px-4 py-2.5 bg-primary text-white rounded-xl text-[10px] font-semibold uppercase tracking-wider active:scale-[0.98] transition-transform disabled:opacity-50 flex items-center gap-2"
          >
            <Papicon icon="user-minus" size={13} />
            {blacklistAddAction.state.loading ? m.e1_tickets_bl_adding() : m.e1_tickets_bl_add()}
          </button>
        </div>
      </div>

      <!-- Liste des interdictions en vigueur -->
      <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 overflow-hidden">
        {#if blacklistLoading}
          <div class="p-8 text-center text-xs text-on-surface-variant/50">{m.e1_tickets_bl_loading()}</div>
        {:else if blacklistEntries.length === 0}
          <div class="flex flex-col items-center justify-center py-16 text-on-surface-variant/30">
            <Papicon icon="shield" size={36} class="opacity-50 mb-2" />
            <p class="text-xs font-bold">{m.e1_tickets_bl_empty()}</p>
          </div>
        {:else}
          <div class="divide-y divide-outline-variant/10">
            {#each blacklistEntries as entry (entry.id)}
              <div class="flex items-center gap-3 p-3.5">
                {#if entry.avatarUrl}
                  <img src={entry.avatarUrl} alt={entry.username || entry.userId} class="w-9 h-9 rounded-xl object-cover shrink-0" />
                {:else}
                  <div class="w-9 h-9 rounded-xl bg-surface-container flex items-center justify-center text-primary font-semibold text-sm shrink-0">
                    {(entry.username || '?').charAt(0).toUpperCase()}
                  </div>
                {/if}
                <div class="min-w-0 flex-1">
                  <p class="text-sm font-semibold text-on-surface truncate">@{entry.username || entry.userId}</p>
                  <p class="text-[10px] text-on-surface-variant/60 truncate">
                    {entry.reason || m.e1_tickets_bl_no_reason()}
                  </p>
                  <p class="text-[10px] text-on-surface-variant/40 mt-0.5">
                    {entry.expiresAt
                      ? m.e1_tickets_bl_until({ date: new Date(entry.expiresAt).toLocaleString(dateLocale()) })
                      : m.e1_tickets_bl_permanent()}
                    {#if entry.addedByTag} · {m.e1_tickets_bl_added_by({ name: entry.addedByTag })}{/if}
                  </p>
                  {#if entry.allowReopen}
                    <span class="inline-block mt-1 px-2 py-0.5 rounded-full text-[9px] font-semibold uppercase bg-sky-500/10 text-sky-400 border border-sky-500/20">
                      {m.e1_tickets_bl_reopen_allowed()}
                    </span>
                  {/if}
                </div>
                <button
                  onclick={() => removeFromBlacklist(entry)}
                  class="p-2 rounded-lg bg-rose-500/10 text-rose-500 hover:bg-rose-500 hover:text-white border border-rose-500/15 transition-all shrink-0"
                  title={m.e1_tickets_bl_remove_confirm()}
                >
                  <Papicon icon="trash-2" size={14} />
                </button>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</ModulePage>

<!-- ============================================== -->
<!-- MODALS -->
<!-- ============================================== -->

<!-- Creation / edition d'une macro -->
<Modal
  bind:open={macroModalOpen}
  title={editingMacroId ? 'Modifier la macro' : 'Nouvelle macro'}
  subtitle="Le texte est envoyé dans le salon du ticket, puis les actions s'appliquent."
  size="lg"
  closeOnBackdropClick={!macroSaving}
>
  <div class="space-y-4">
    <div class="grid grid-cols-1 sm:grid-cols-[1fr_140px_80px] gap-3">
      <label class="block">
        <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Nom</span>
        <FormInput type="text" bind:value={macroForm.name} placeholder="Demande de preuves" className="w-full" />
      </label>
      <label class="block">
        <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Catégorie</span>
        <FormInput type="text" bind:value={macroForm.category} placeholder="Modération" className="w-full" />
      </label>
      <label class="block">
        <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Emoji</span>
        <FormInput type="text" bind:value={macroForm.emoji} placeholder="📎" className="w-full" />
      </label>
    </div>

    <label class="block">
      <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Contenu</span>
      <FormTextarea
        bind:value={macroForm.content}
        placeholder={'Bonjour {user}, pourriez-vous joindre une capture ?'}
        className="w-full h-28"
      />
      <span class="text-[10px] text-on-surface-variant/60 ml-1 mt-1 block">
        2000 caractères maximum, la limite d'un message Discord.
      </span>
    </label>

    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div>
        <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Types de ticket concernés</span>
        <MultiSelect
          bind:values={macroForm.ticketTypeIds}
          options={ticketTypes.map((t: any) => ({ id: t.id, name: t.label }))}
          placeholder="Tous les types"
        />
      </div>
      <div>
        <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Rôles autorisés</span>
        <MultiSelect
          bind:values={macroForm.allowedRoleIds}
          options={discordRoles.map(r => ({ id: r.id, name: `@${r.name}` }))}
          placeholder="Tout le staff"
        />
      </div>
    </div>

    <label class="block">
      <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Mots-clés de suggestion</span>
      <FormInput type="text" bind:value={macroKeywordsText} placeholder="remboursement, facture, paiement" className="w-full" />
      <span class="text-[10px] text-on-surface-variant/60 ml-1 mt-1 block">
        Séparés par des virgules. Si l'un d'eux apparaît dans la demande, la macro remonte en tête du sélecteur.
      </span>
    </label>

    <div class="border-t border-outline-variant/10 pt-4 space-y-3">
      <p class="text-xs font-bold text-on-surface">Actions attachées</p>
      <p class="text-[10px] text-on-surface-variant/60 -mt-2">
        Appliquées après l'envoi du texte. La fermeture vient toujours en dernier.
      </p>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Requalifier en</span>
          <FormSelect bind:value={macroForm.setTicketTypeId} className="w-full">
            <option value="">Ne pas changer</option>
            {#each ticketTypes as t (t.id)}
              <option value={t.id}>{t.label}</option>
            {/each}
          </FormSelect>
        </div>
        <div>
          <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Ajouter le rôle</span>
          <FormSelect bind:value={macroForm.addRoleId} className="w-full">
            <option value="">Aucun</option>
            {#each discordRoles as role (role.id)}
              <option value={role.id}>@{role.name}</option>
            {/each}
          </FormSelect>
        </div>
        <div>
          <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Retirer le rôle</span>
          <FormSelect bind:value={macroForm.removeRoleId} className="w-full">
            <option value="">Aucun</option>
            {#each discordRoles as role (role.id)}
              <option value={role.id}>@{role.name}</option>
            {/each}
          </FormSelect>
        </div>
      </div>

      <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
        <input type="checkbox" bind:checked={macroForm.requestSatisfaction} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
        <span class="text-xs font-bold text-on-surface">Déclencher l'enquête de satisfaction</span>
      </label>
      <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
        <input type="checkbox" bind:checked={macroForm.closeTicket} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
        <span class="text-xs font-bold text-on-surface">Fermer le ticket</span>
      </label>
    </div>

    <div class="border-t border-outline-variant/10 pt-4 space-y-3">
      <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
        <input type="checkbox" bind:checked={macroForm.autoSendOnOpen} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
        <div>
          <span class="text-xs font-bold text-on-surface">Envoyer automatiquement à l'ouverture</span>
          <p class="text-[10px] text-on-surface-variant/60">
            Seul le texte part : les actions attachées ne s'appliquent pas, fermer ou requalifier
            un ticket qui vient de naître ferait plus de dégâts que de bien.
          </p>
        </div>
      </label>
      <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
        <input type="checkbox" bind:checked={macroForm.enabled} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
        <span class="text-xs font-bold text-on-surface">Macro active</span>
      </label>
    </div>

    <div class="flex justify-end gap-2 pt-1">
      <ActionButton variant="neutral" label="Annuler" disabled={macroSaving} onclick={() => (macroModalOpen = false)} />
      <ActionButton
        variant="primary"
        label={macroSaving ? 'Enregistrement…' : 'Enregistrer'}
        disabled={macroSaving}
        onclick={saveMacro}
      />
    </div>
  </div>
</Modal>

<!-- Avis d'un membre du staff (pagines) -->
{#if reviewsModalStaff}
  <div class="fixed inset-0 z-100 flex items-center justify-center p-4 bg-black/60">
    <div class="bg-surface border border-outline-variant/30 rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-sm animate-in zoom-in-95 duration-300">
      <div class="flex items-center gap-3 p-6 border-b border-outline-variant/20">
        {#if reviewsModalStaff.staff?.avatarUrl}
          <img src={reviewsModalStaff.staff.avatarUrl} alt="" class="w-10 h-10 rounded-full object-cover" />
        {:else}
          <span class="w-10 h-10 rounded-full bg-surface-container-high flex items-center justify-center text-xs font-bold">
            {getSatisfactionInitials(reviewsModalStaff.staff, reviewsModalStaff.staffId)}
          </span>
        {/if}
        <div class="min-w-0 flex-1">
          <h3 class="text-base font-semibold truncate">{m.e1_tickets_sat_reviews_of({ name: getSatisfactionPersonName(reviewsModalStaff.staff, reviewsModalStaff.staffId) })}</h3>
          <p class="text-[11px] text-on-surface-variant/60">{m.e1_tickets_sat_reviews_count({ count: reviewsModalTotal })}</p>
        </div>
        <button type="button" class="sat-staff-chip" class:sat-chip-active={reviewsModalCommentsOnly} onclick={toggleReviewsCommentsOnly}>
          <Papicon icon="message-square" size={13} />
          {m.e1_tickets_sat_comments_only()}
        </button>
        <button type="button" onclick={closeStaffReviews} aria-label={m.common_cancel()} class="p-2 rounded-lg hover:bg-surface-container transition-colors">
          <Papicon icon="close" size={18} />
        </button>
      </div>

      <div class="flex-1 overflow-y-auto p-6 space-y-3">
        {#if reviewsModalLoading && reviewsModalItems.length === 0}
          <div class="flex items-center justify-center py-10">
            <div class="w-6 h-6 rounded-full border-4 border-primary border-t-transparent animate-spin"></div>
          </div>
        {:else if reviewsModalItems.length === 0}
          <p class="sat-empty">{m.e1_tickets_sat_no_review()}</p>
        {:else}
          {#each reviewsModalItems as review}
            <div class="sat-comment">
              <div class="sat-comment-head">
                <span class="sat-comment-emoji">{ratingEmojis[review.rating]}</span>
                <button type="button" class="sat-comment-author sat-clickable-person" onclick={() => openSatisfactionMember(review.userId, review.user)}>
                  {getSatisfactionPersonName(review.user, review.userId)}
                </button>
                <span class="sat-comment-rating" style="color: {getRatingColor(review.rating)}">{ratingLabels[review.rating]}</span>
                <span class="sat-comment-date">{new Date(review.createdAt).toLocaleDateString(dateLocale())}</span>
              </div>
              {#if review.comment}
                <p class="sat-comment-body">{review.comment}</p>
              {:else}
                <p class="sat-comment-body sat-comment-empty">{m.e1_tickets_sat_no_comment()}</p>
              {/if}
            </div>
          {/each}

          {#if reviewsModalHasMore}
            <button
              type="button"
              class="w-full py-3 rounded-xl text-xs font-semibold bg-surface-container hover:bg-surface-container-high transition-colors disabled:opacity-50"
              disabled={reviewsModalLoading}
              onclick={() => fetchReviewsPage(reviewsModalOffset, true)}
            >
              {reviewsModalLoading ? m.common_loading() : m.e1_tickets_sat_load_more()}
            </button>
          {/if}
        {/if}
      </div>
    </div>
  </div>
{/if}

<!-- Ticket Close Modal -->
{#if showCloseModal}
  <div class="fixed inset-0 z-100 flex items-center justify-center p-4 bg-black/60">
    <div class="bg-surface border border-outline-variant/30 rounded-xl w-full max-w-lg shadow-sm p-10 animate-in zoom-in-95 duration-300">
      <div class="flex items-center gap-4 mb-2 text-rose-500">
        <Papicon icon="x-circle" size={36} />
        <h3 class="text-2xl font-semibold">{m.e1_tickets_close_modal_title()}</h3>
      </div>
      <p class="text-sm text-on-surface-variant/80 mb-6">{m.e1_tickets_close_modal_desc()}</p>
      
      <div>
        <label for="close-reason-input" class="field-label">{m.e1_tickets_close_reason_label()}</label>
        <textarea id="close-reason-input" bind:value={closeReason} class="w-full h-32 bg-surface-container rounded-lg p-4 focus:outline-hidden border-2 border-transparent focus:border-primary/50 text-sm" placeholder={m.e1_tickets_close_reason_ph()}></textarea>
      </div>
      
      <div class="flex gap-4 mt-8 pt-6 border-t border-outline-variant/20">
        <button onclick={() => showCloseModal = false} class="flex-1 py-4 rounded-xl font-bold bg-surface-container hover:bg-surface-container-high transition-colors">{m.common_cancel()}</button>
        <button 
          onclick={closeTicket} 
          class="flex-1 py-4 rounded-xl font-bold bg-rose-600 text-white active:scale-[0.98] transition-transform shadow-sm"
        >
          {m.e1_tickets_close_confirm()}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Ticket Delete Confirm Modal -->
{#if showDeleteConfirmModal}
  <div class="fixed inset-0 z-100 flex items-center justify-center p-4 bg-black/60">
    <div class="bg-surface border border-outline-variant/30 rounded-xl w-full max-w-md shadow-sm p-10 animate-in zoom-in-95 duration-300">
      <div class="flex items-center gap-4 mb-2 text-rose-500">
        <Papicon icon="delete" size={36} />
        <h3 class="text-2xl font-semibold">{m.e1_tickets_delete_modal_title()}</h3>
      </div>
      <p class="text-sm text-on-surface-variant/80 mb-6">{m.e1_tickets_delete_modal_desc()}</p>
      
      <div class="flex gap-4 mt-8 pt-6 border-t border-outline-variant/20">
        <button onclick={() => showDeleteConfirmModal = false} class="flex-1 py-4 rounded-xl font-bold bg-surface-container hover:bg-surface-container-high transition-colors">{m.common_cancel()}</button>
        <button 
          onclick={deleteTicket} 
          class="flex-1 py-4 rounded-xl font-bold bg-rose-600 text-white active:scale-[0.98] transition-transform shadow-sm"
        >
          {m.e1_tickets_delete_confirm()}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Ticket Deletion Lock Modal -->
{#if showLockModal}
  <div class="fixed inset-0 z-100 flex items-center justify-center p-4 bg-black/60">
    <div class="bg-surface border border-outline-variant/30 rounded-xl w-full max-w-md shadow-sm p-10 animate-in zoom-in-95 duration-300">
      <div class="flex items-center gap-4 mb-2 text-amber-500">
        <Papicon icon="lock" size={36} />
        <h3 class="text-2xl font-semibold">{m.e1_tickets_lock_modal_title()}</h3>
      </div>
      <p class="text-sm text-on-surface-variant/80 mb-6">{m.e1_tickets_lock_modal_intro()}</p>

      <label class="block text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant/70 mb-2" for="ticket-lock-duration">
        {m.e1_tickets_lock_duration()}
      </label>
      <div id="ticket-lock-duration" class="grid grid-cols-2 gap-2 mb-6">
        {#each [['7d', m.e1_tickets_lock_duration_7d()], ['30d', m.e1_tickets_lock_duration_30d()], ['90d', m.e1_tickets_lock_duration_90d()], ['permanent', m.e1_tickets_lock_duration_permanent()]] as [value, label]}
          <button
            type="button"
            onclick={() => lockDuration = value as typeof lockDuration}
            class="py-2.5 rounded-lg text-xs font-semibold transition-all border {lockDuration === value ? 'bg-amber-500 text-white border-amber-500' : 'bg-surface-container border-outline-variant/20 text-on-surface-variant hover:bg-surface-container-high'}"
          >
            {label}
          </button>
        {/each}
      </div>

      <label class="block">
        <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">{m.e1_tickets_lock_reason()}</span>
        <FormTextarea bind:value={lockReason} placeholder={m.e1_tickets_lock_reason_ph()} rows={3} className="w-full" />
      </label>

      <div class="flex gap-4 mt-8 pt-6 border-t border-outline-variant/20">
        <button onclick={() => showLockModal = false} class="flex-1 py-4 rounded-xl font-bold bg-surface-container hover:bg-surface-container-high transition-colors">{m.common_cancel()}</button>
        <button
          onclick={lockTicket}
          disabled={lockBusy}
          class="flex-1 py-4 rounded-xl font-bold bg-amber-500 text-white active:scale-[0.98] transition-transform shadow-sm disabled:opacity-50"
        >
          {lockBusy ? '…' : m.e1_tickets_lock_confirm()}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Ticket Restore Modal -->
{#if showRestoreModal}
  {@const rc = selectedTicketDetail?.restoreCount ?? 0}
  {@const maxRestores = 3}
  {@const remaining = maxRestores - rc}
  <div class="fixed inset-0 z-100 flex items-center justify-center p-4 bg-black/60">
    <div class="bg-surface border border-outline-variant/30 rounded-xl w-full max-w-lg shadow-sm p-10 animate-in zoom-in-95 duration-300">
      <div class="flex items-center gap-4 mb-2 text-purple-400">
        <Papicon icon="refresh-ccw" size={36} />
        <h3 class="text-2xl font-semibold">{m.e1_tickets_restore_modal_title()}</h3>
      </div>
      <p class="text-sm text-on-surface-variant/80 mb-4">{m.e1_tickets_restore_modal_intro()}</p>
      <ul class="text-sm text-on-surface-variant/80 mb-6 space-y-2 list-disc ml-5">
        <li>{m.e1_tickets_restore_step1_pre()}<strong>{m.e1_tickets_restore_step1_strong()}</strong>{m.e1_tickets_restore_step1_post()}</li>
        <li>{m.e1_tickets_restore_step2_pre()}<strong>{m.e1_tickets_restore_step2_strong()}</strong>{m.e1_tickets_restore_step2_post()}</li>
        <li>{m.e1_tickets_restore_step3_pre()}<strong>{m.e1_tickets_restore_step3_strong()}</strong></li>
      </ul>

      <div class="flex items-start gap-2 p-3 rounded-lg bg-purple-500/5 border border-purple-500/15 mb-4">
        <Papicon icon="info" size={14} class="text-purple-400 mt-0.5 shrink-0" />
        <div class="text-[10px] text-purple-300/80 leading-relaxed">
          <p class="font-semibold mb-1">{m.e1_tickets_restore_limits_title({ remaining, max: maxRestores })}</p>
          <p>{m.e1_tickets_restore_limits_desc()}</p>
        </div>
      </div>

      <div class="flex items-start gap-2 p-3 rounded-lg bg-amber-500/5 border border-amber-500/15 mb-6">
        <Papicon icon="alert-triangle" size={14} class="text-amber-500 mt-0.5 shrink-0" />
        <p class="text-[10px] text-amber-500/80 leading-relaxed">{m.e1_tickets_restore_warning()}</p>
      </div>

      <div class="flex gap-4 mt-8 pt-6 border-t border-outline-variant/20">
        <button onclick={() => showRestoreModal = false} disabled={restoring} class="flex-1 py-4 rounded-xl font-bold bg-surface-container hover:bg-surface-container-high transition-colors disabled:opacity-50">{m.common_cancel()}</button>
        <button
          onclick={restoreTicket}
          disabled={restoring}
          class="flex-1 py-4 rounded-xl font-bold bg-purple-600 text-white active:scale-[0.98] transition-transform shadow-sm disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {#if restoring}
            <div class="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin"></div>
            {m.e1_tickets_restoring()}
          {:else}
            {m.e1_tickets_restore_confirm()}
          {/if}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Member Case Modal -->
{#if caseModalOpen}
  {#await import('../lib/components/MemberCaseModal.svelte') then module}
    {@const MemberCaseModal = module.default}
    <MemberCaseModal
      open={caseModalOpen}
      userId={selectedCaseUser?.id}
      userName={selectedCaseUser?.name || ''}
      caseData={selectedCaseData}
      loading={selectedCaseLoading}
      error={selectedCaseError}
      actionReason={memberActionReason}
      actionDuration={memberActionDuration}
      actionBusy={memberActionBusy}
      actionFeedback={memberActionFeedback}
      actionIsError={memberActionIsError}
      onClose={closeCaseModal}
      onAction={executeMemberAction}
    />
  {/await}
{/if}

<style>
  .scrollbar-hide::-webkit-scrollbar { display: none; }
  .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }

  @media (max-width: 767px) {
    .tickets-primary-tabs {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      overflow: visible;
      border: 1px solid var(--outline-variant);
      border-radius: 0.875rem;
      background: var(--surface-container-low);
      padding: 0.25rem;
      gap: 0.25rem;
    }

    .tickets-primary-tabs :global(.tab-button) {
      width: 100%;
      min-width: 0;
      border-radius: 0.625rem;
      text-align: center;
      white-space: normal;
    }

    .tickets-primary-tabs :global(.tab-button.active) {
      background: var(--surface-container-lowest);
    }

    .tickets-primary-tabs :global(.tab-button > div) {
      right: 0.75rem;
      left: 0.75rem;
      width: auto;
    }
  }

  /* Satisfaction Tab Styles */
  .sat-grid { display: grid; grid-template-columns: 300px 1fr; gap: 1rem; }
  .sat-card { background: var(--color-surface, rgba(255,255,255,0.05)); border: 1px solid var(--color-outline-variant); border-radius: 12px; padding: 1.25rem; }
  .sat-card-title { margin: 0 0 1rem; font-size: 0.95rem; color: var(--color-on-surface-variant); }

  .sat-overview-card { text-align: center; }
  .sat-avg-rating { display: flex; align-items: baseline; justify-content: center; gap: 0.25rem; }
  .sat-avg-value { font-size: 3rem; font-weight: 700; }
  .sat-avg-max { font-size: 1rem; color: color-mix(in srgb, var(--color-on-surface-variant) 75%, transparent); }
  .sat-avg-label { color: color-mix(in srgb, var(--color-on-surface-variant) 75%, transparent); font-size: 0.875rem; margin: 0.5rem 0 1.5rem; }

  .sat-distribution { display: flex; flex-direction: column; gap: 0.5rem; }
  .sat-dist-row { display: grid; grid-template-columns: 40px 1fr 30px; align-items: center; gap: 0.5rem; }
  .sat-dist-label { font-size: 0.85rem; }
  .sat-dist-bar { height: 8px; background: var(--color-outline-variant); border-radius: 4px; overflow: hidden; }
  .sat-dist-fill { height: 100%; background: var(--color-primary, #5865F2); border-radius: 4px; }
  .sat-dist-count { text-align: right; font-size: 0.8rem; color: color-mix(in srgb, var(--color-on-surface-variant) 75%, transparent); }

  .sat-staff-list { display: flex; flex-direction: column; gap: 0.5rem; }
  .sat-staff-item { border-radius: 10px; border: 1px solid transparent; transition: border-color 160ms ease, background-color 160ms ease; }
  .sat-staff-item:has(.sat-comment-list) { border-color: var(--color-outline-variant); background: var(--color-surface-container, rgba(255,255,255,0.03)); }
  .sat-staff-row { display: flex; align-items: center; gap: 0.75rem; width: 100%; padding: 0.55rem; border-radius: 8px; text-align: left; }
  .sat-staff-rating { font-weight: 600; }
  .sat-staff-count { font-size: 0.8rem; color: color-mix(in srgb, var(--color-on-surface-variant) 75%, transparent); }
  .sat-staff-actions { display: flex; align-items: center; gap: 0.35rem; margin-left: auto; flex: 0 0 auto; }
  .sat-staff-chip {
    display: inline-flex; align-items: center; gap: 0.3rem;
    padding: 0.28rem 0.55rem; border-radius: 999px; cursor: pointer;
    border: 1px solid var(--color-outline-variant);
    background: transparent; color: var(--color-on-surface-variant);
    font: inherit; font-size: 0.72rem; font-weight: 700; white-space: nowrap;
    transition: background-color 160ms ease, color 160ms ease, border-color 160ms ease;
  }
  .sat-staff-chip:hover:not(:disabled) { background: var(--color-surface-container-high, rgba(255,255,255,0.08)); color: var(--color-on-surface); }
  .sat-staff-chip:focus-visible { outline: 2px solid var(--color-primary, #5865F2); outline-offset: 2px; }
  .sat-staff-chip-muted { opacity: 0.45; cursor: default; }
  .sat-chip-active { border-color: var(--color-primary, #5865F2); color: var(--color-primary, #5865F2); }

  .sat-comment-list { display: flex; flex-direction: column; gap: 0.5rem; padding: 0 0.55rem 0.65rem 3.35rem; }
  .sat-comment {
    border-left: 2px solid var(--color-primary, #5865F2);
    padding: 0.35rem 0 0.35rem 0.65rem;
  }
  .sat-comment-head { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; font-size: 0.75rem; }
  .sat-comment-emoji { font-size: 0.95rem; }
  .sat-comment-author { font-weight: 700; border-radius: 4px; padding: 0 0.15rem; }
  .sat-comment-rating { font-weight: 600; }
  .sat-comment-date { color: color-mix(in srgb, var(--color-on-surface-variant) 75%, transparent); margin-left: auto; }
  /* Un avis est du texte libre : il doit passer a la ligne, jamais deborder. */
  .sat-comment-body { margin: 0.2rem 0 0; font-size: 0.82rem; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--color-on-surface); }
  .sat-comment-empty { font-style: italic; color: color-mix(in srgb, var(--color-on-surface-variant) 75%, transparent); }
  .sat-comment-more {
    align-self: flex-start; border: 0; background: transparent; cursor: pointer; padding: 0;
    font: inherit; font-size: 0.72rem; font-weight: 700; color: var(--color-primary, #5865F2);
  }
  .sat-comment-more:hover { text-decoration: underline; }

  .sat-recent-card { grid-column: 1 / -1; }
  .sat-recent-list { display: flex; flex-direction: column; gap: 0.25rem; }
  .sat-review-item { padding: 0.35rem 0; border-bottom: 1px solid var(--color-outline-variant); }
  .sat-review-item:last-child { border-bottom: 0; }
  .sat-review-row { display: grid; grid-template-columns: 2rem minmax(180px, 260px) minmax(0, 1fr) auto; align-items: center; gap: 0.75rem; padding: 0.1rem 0; font-size: 0.85rem; }
  .sat-review-emoji { font-size: 1.1rem; }
  .sat-review-user { min-width: 0; }
  .sat-review-staff { color: color-mix(in srgb, var(--color-on-surface-variant) 75%, transparent); font-size: 0.75rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sat-review-comment {
    margin: 0.15rem 0 0.35rem 2.75rem; font-size: 0.82rem; line-height: 1.45;
    white-space: pre-wrap; overflow-wrap: anywhere;
    color: var(--color-on-surface);
    border-left: 2px solid var(--color-outline-variant); padding-left: 0.6rem;
  }
  .sat-review-date { color: color-mix(in srgb, var(--color-on-surface-variant) 75%, transparent); font-size: 0.75rem; }

  .sat-clickable-person { border: 0; background: transparent; color: inherit; cursor: pointer; font: inherit; padding: 0; transition: background-color 160ms ease, color 160ms ease; }
  .sat-clickable-person:hover { background: var(--color-surface-container-high, rgba(255,255,255,0.08)); }
  .sat-clickable-person:focus-visible { outline: 2px solid var(--color-primary, #5865F2); outline-offset: 2px; }
  .sat-person-main,
  .sat-review-user { display: flex; align-items: center; gap: 0.65rem; }
  .sat-person-main { flex: 1; min-width: 0; }
  .sat-person-avatar { width: 2rem; height: 2rem; border-radius: 999px; object-fit: cover; flex: 0 0 auto; }
  .sat-avatar-fallback { display: inline-flex; align-items: center; justify-content: center; background: var(--color-primary, #5865F2); color: white; font-size: 0.68rem; font-weight: 800; }
  .sat-person-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.15; }
  .sat-person-name { color: var(--color-on-surface); font-size: 0.86rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sat-person-handle { color: color-mix(in srgb, var(--color-on-surface-variant) 75%, transparent); font-size: 0.7rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .sat-empty { color: color-mix(in srgb, var(--color-on-surface-variant) 75%, transparent); font-style: italic; }

  @media (max-width: 768px) {
    .sat-grid { grid-template-columns: 1fr; }
    .sat-review-row { grid-template-columns: 2rem minmax(0, 1fr) auto; }
    .sat-review-staff { display: none; }
    .sat-review-comment { margin-left: 0; }
    .sat-staff-row { flex-wrap: wrap; }
    .sat-staff-actions { margin-left: 0; width: 100%; }
    .sat-comment-list { padding-left: 0.55rem; }
  }
</style>
