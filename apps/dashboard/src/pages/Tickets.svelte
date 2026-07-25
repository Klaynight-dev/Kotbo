<script lang="ts">
  import { m } from '../lib/i18n';
  import { channelDisplayName } from '../lib/channelUtils';
  import { onMount, onDestroy } from 'svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import { useUnsavedChanges } from '../lib/useUnsavedChanges.svelte';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import {
    API_BASE_URL,
    fetchMemberCase,
    runMemberCaseAction,
    fetchSatisfactionData,
    fetchStaffServerChannels
  } from '../lib/api';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import FormInput from '../lib/components/FormInput.svelte';
  import FormTextarea from '../lib/components/FormTextarea.svelte';
  import FormSelect from '../lib/components/FormSelect.svelte';
  import FormColorPicker from '../lib/components/FormColorPicker.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import MemberCaseModal from '../lib/components/MemberCaseModal.svelte';
  import EmojiPicker from '../lib/components/EmojiPicker.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';

  // Navigation & Tabs
  let activeTab = $state<'tickets' | 'transcripts' | 'satisfaction' | 'config'>('tickets');
  let ticketFilter = $state<'ALL' | 'OPEN' | 'CLAIMED' | 'CLOSED'>('ALL');
  
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
  let wsListener = $state<((e: any) => void) | null>(null);
  
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
  let ticketInactivityEnabled = $state(false);
  let ticketInactivityHours = $state(24);
  let ticketInactivityMessage = $state(m.e1_tickets_default_inactivity_message({ user: '{user}' }));
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
    if (rating >= 4.5) return 'var(--color-success, #22c55e)';
    if (rating >= 3.5) return 'var(--color-primary, #5865F2)';
    if (rating >= 2.5) return 'var(--color-warning, #f59e0b)';
    return 'var(--color-danger, #ef4444)';
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
    ticketInactivityEnabled,
    ticketInactivityHours,
    ticketInactivityMessage,
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
    ticketInactivityEnabled = savedSettingsConfig.ticketInactivityEnabled;
    ticketInactivityHours = savedSettingsConfig.ticketInactivityHours;
    ticketInactivityMessage = savedSettingsConfig.ticketInactivityMessage;
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

  async function changeTab(tab: 'tickets' | 'transcripts' | 'satisfaction' | 'config') {
    if (unsavedChanges.isDirty && unsavedChanges.pageLabel === m.e1_tickets_config_label()) {
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
    activeTab = tab;
  }

  // Derived values from Dashboard Store
  const discordChannels = $derived(dashboardStore.state.discordChannels || []);
  const discordCategories = $derived(dashboardStore.state.discordCategories || []);
  const discordRoles = $derived(dashboardStore.state.discordRoles || []);

  const saveAction = createAsyncActionState();
  const sendEmbedAction = createAsyncActionState();
  const renameAction = createAsyncActionState();

  function createTicketTypeDraft(index = 0, legacy?: any) {
    return {
      id: legacy?.ticketTypeId || crypto.randomUUID(),
      label: legacy?.ticketEmbedButtonText || `Ticket ${index + 1}`,
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
          label: typeof item.label === 'string' && item.label.trim() ? item.label.trim().slice(0, 80) : `Ticket ${index + 1}`,
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
          formEnabled: item.formEnabled !== undefined ? item.formEnabled : true,
          formCustomFields: Array.isArray(item.formCustomFields)
            ? item.formCustomFields.map((f: any) => ({
                id: f.id,
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
      toast.error("Discord limite les formulaires (Modals) à 5 champs maximum.");
      return;
    }
    const newId = 'field_' + Math.random().toString(36).substring(2, 10);
    ticketType.formCustomFields = [...ticketType.formCustomFields, {
      id: newId,
      label: `Question ${ticketType.formCustomFields.length + 1}`,
      placeholder: '',
      style: 'SHORT',
      required: true
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
  async function loadTicketsAndConfig() {
    if (!authStore.selectedGuildId) return;
    loading = true;
    error = '';
    try {
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/tickets`, {
        headers: { 'Authorization': `Bearer ${authStore.token}` }
      });
      if (!res.ok) throw new Error('Impossible de charger le système de tickets');
      const data = await res.json();
      tickets = data.tickets || [];
      config = data.config || {};
      
      // Populate config bindings
      ticketCategoryId = config.ticketCategoryId || '';
      ticketLogChannelId = config.ticketLogChannelId || '';
      ticketStaffRoleId = config.ticketStaffRoleId || '';
      ticketChannelId = config.ticketChannelId || '';
      ticketEmbedTitle = config.ticketEmbedTitle || 'Support Technique';
      ticketEmbedDesc = config.ticketEmbedDesc || 'Cliquez sur le bouton ci-dessous pour ouvrir un ticket de support.';
      ticketEmbedButtonText = config.ticketEmbedButtonText || 'Ouvrir un ticket';
      ticketEmbedColor = config.ticketEmbedColor || '#5865F2';
      ticketEmbedType = config.ticketEmbedType === 'DROPDOWN' ? 'DROPDOWN' : 'BUTTONS';
      ticketMode = config.ticketMode || 'CHANNEL';
      ticketDmRelayChannelId = config.ticketDmRelayChannelId || '';
      ticketAllowOverclaim = config.ticketAllowOverclaim !== undefined ? config.ticketAllowOverclaim : true;
      ticketOverclaimPermission = config.ticketOverclaimPermission || 'ANY';
      ticketInactivityEnabled = config.ticketInactivityEnabled !== undefined ? config.ticketInactivityEnabled : false;
      ticketInactivityHours = config.ticketInactivityHours !== undefined ? config.ticketInactivityHours : 24;
      ticketInactivityMessage = config.ticketInactivityMessage || "Bonjour {user}, votre ticket est inactif depuis un moment. N'hésitez pas à y répondre si vous avez toujours besoin d'aide !";
      ticketTypes = normalizeTicketTypes(config);
      ticketEmbedThumbnail = config.ticketEmbedThumbnail || '';
      ticketEmbedImage = config.ticketEmbedImage || '';
      ticketEmbedFooter = config.ticketEmbedFooter || '';
      ticketEmbedAuthorName = config.ticketEmbedAuthorName || '';
      ticketEmbedAuthorIcon = config.ticketEmbedAuthorIcon || '';
      ticketWelcomeTitle = config.ticketWelcomeTitle || "🎫 Ticket d'Assistance · {type_label}";
      ticketWelcomeDesc = config.ticketWelcomeDesc || "Bonjour {user} !\nLe personnel {staff_mention} va prendre en charge votre demande rapidement. En attendant, merci de bien détailler vos questions ou explications.\n\n**Description du problème :**\n{description}";
      ticketWelcomeColor = config.ticketWelcomeColor || '#5865F2';
      ticketWelcomeThumbnail = config.ticketWelcomeThumbnail || '';
      ticketWelcomeImage = config.ticketWelcomeImage || '';
      ticketWelcomeFooter = config.ticketWelcomeFooter || 'Kotbo · Ticket ID: {ticket_id}';
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
        ticketInactivityEnabled,
        ticketInactivityHours,
        ticketInactivityMessage,
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
    }
  }

  // Fetch transcripts for this guild
  async function loadTranscripts() {
    if (!authStore.selectedGuildId) return;
    loading = true;
    error = '';
    try {
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/tickets/transcripts`, {
        headers: { 'Authorization': `Bearer ${authStore.token}` }
      });
      if (!res.ok) throw new Error('Impossible de charger les transcriptions');
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
      if (!res.ok) throw new Error('Impossible de charger le détail du ticket');
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
      if (!res.ok) throw new Error('Impossible d\'envoyer le message');
      // Reload actual messages
      await loadTicketDetail(selectedTicketId, false);
    } catch (err: any) {
      toast.error(err.message || 'Une erreur est survenue');
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
      if (!res.ok) throw new Error('Erreur lors du claim');
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
      if (!res.ok) throw new Error('Erreur de fermeture');
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
      if (!res.ok) throw new Error('Erreur de renommage');
      const data = await res.json().catch(() => null);
      if (data?.channelName) {
        ticketRenameName = data.channelName;
      }
      await loadTicketDetail(ticketId, false);
      await loadTicketsAndConfig();
      return true;
    }, { successMessage: 'Ticket renommé avec succès !' });
  }

  // Reopen Ticket
  async function reopenTicket() {
    if (!selectedTicketId || !authStore.selectedGuildId) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/tickets/${selectedTicketId}/reopen`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authStore.token}` }
      });
      if (!res.ok) throw new Error('Erreur de réouverture');
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
        throw new Error(data.error || 'Erreur de restauration');
      }
      showRestoreModal = false;
      toast.success('Ticket restauré avec succès ! Le salon a été recréé avec l\'historique.');
      await loadTicketDetail(selectedTicketId, false);
      await loadTicketsAndConfig();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      restoring = false;
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
      if (!res.ok) throw new Error('Erreur de suppression');
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
          ticketTypes,
          ticketAllowOverclaim,
          ticketOverclaimPermission,
          ticketInactivityEnabled,
          ticketInactivityHours,
          ticketInactivityMessage,
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
      if (!res.ok) throw new Error('Erreur lors de la sauvegarde');
      await dashboardStore.refresh();
      await loadTicketsAndConfig();
      success = true;
      return true;
    }, { successMessage: 'Configuration enregistrée avec succès !' });
    return success;
  }

  // Send Panel to Discord
  async function sendEmbedPanel() {
    if (!(await confirmDialog.ask({ title: 'Envoyer le panel de tickets ?', description: 'Le panel d\'ouverture de ticket sera publié dans le salon configuré.', confirmLabel: 'Envoyer' }))) return;
    await sendEmbedAction.run(async () => {
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/tickets/config/send-embed`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authStore.token}` }
      });
      if (!res.ok) throw new Error('Erreur d\'envoi du panel');
      return true;
    }, { successMessage: 'Panel de tickets envoyé avec succès !' });
  }

  // Member Case Logic
  async function loadMemberCaseDetails(userId: string) {
    selectedCaseLoading = true;
    selectedCaseError = '';
    try {
      selectedCaseData = await fetchMemberCase(userId);
    } catch (err: any) {
      selectedCaseError = err.message || 'Impossible de charger le dossier membre.';
      selectedCaseData = null;
    } finally {
      selectedCaseLoading = false;
    }
  }

  function openMemberCase(userId: string, userName: string) {
    selectedCaseUser = { name: userName, id: userId };
    selectedCaseData = null;
    selectedCaseError = '';
    memberActionReason = 'Action lancée depuis le panel de Tickets.';
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
        reason: memberActionReason.trim() || 'Action lancée depuis Tickets.',
        durationMs: durationMs ?? undefined
      });
      memberActionFeedback = 'Action appliquée avec succès.';
      await loadMemberCaseDetails(selectedCaseUser.id);
    } catch (err: any) {
      memberActionIsError = true;
      memberActionFeedback = err.message || 'L’action a échoué.';
    } finally {
      memberActionBusy = false;
    }
  }

  function getStatusLabel(status: string) {
    switch (status) {
      case 'OPEN': return 'Ouvert';
      case 'CLAIMED': return 'Pris en charge';
      case 'CLOSED': return 'Fermé';
      default: return status;
    }
  }

  function getStatusColor(status: string) {
    switch (status) {
      case 'OPEN': return 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20';
      case 'CLAIMED': return 'bg-amber-500/10 text-amber-500 border-amber-500/20';
      case 'CLOSED': return 'bg-rose-500/10 text-rose-500 border-rose-500/20';
      default: return 'bg-outline-variant/10 text-on-surface-variant border-outline-variant/20';
    }
  }

  $effect(() => {
    if (activeTab === 'transcripts') {
      void loadTranscripts();
    } else if (activeTab === 'satisfaction') {
      void loadSatisfaction();
    }
  });

  // Serveur staff lié — pour l'option "ticket interne"
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

    wsListener = (e: CustomEvent) => {
      const payload = e.detail;
      if (payload?.type === 'new_ticket_message' && payload.ticketId === selectedTicketId) {
        if (!messages.some(m => m.id === payload.message.id)) {
          // Remplacer les messages temporaires par le message officiel Discord reçu en temps réel
          messages = [
            ...messages.filter(m => !m.id.startsWith('temp-') || m.content !== payload.message.content),
            payload.message
          ];
          setTimeout(scrollToBottom, 50);
        }
      }
    };

    window.addEventListener('kotbo-ws-message', wsListener as any);
  });

  onDestroy(() => {
    if (wsListener) {
      window.removeEventListener('kotbo-ws-message', wsListener as any);
    }
  });
</script>

<ModulePage 
  title="Système de Tickets" 
  description="Gérez les tickets de support en temps réel, communiquez avec les utilisateurs et gérez la configuration." 
  icon="message-square"
  featureKey="tickets"
>
  {#snippet actions()}
    <div class="flex items-center gap-3">
      <RefreshButton onClick={handleRefresh} loading={loading} label="Actualiser" />
      <button 
      onclick={() => changeTab(activeTab === 'config' ? 'tickets' : 'config')}
        class="p-3 rounded-xl bg-surface-container-high hover:bg-primary/10 hover:text-primary transition-all text-on-surface-variant/70"
        title="Paramètres de configuration"
      >
        <Papicon icon="settings" size={20} />
      </button>
    </div>
  {/snippet}

  <!-- Tab Switcher -->
  <div class="flex border-b border-outline-variant/10 mb-6 overflow-x-auto scrollbar-hide">
    {#each [
      { key: 'tickets', label: 'Tickets' },
      { key: 'transcripts', label: 'Transcriptions' },
      { key: 'satisfaction', label: 'Satisfaction' },
      { key: 'config', label: 'Configuration' }
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
    <!-- Tickets Main View — mobile: master/detail pattern -->
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-4 lg:gap-6 h-auto lg:h-[75vh]">

      <!-- Left Panel: Tickets Browser -->
      <div class="lg:col-span-4 bg-surface-container-low/40 border border-outline-variant/10 rounded-xl p-4 lg:p-6 flex flex-col overflow-hidden {showMobileChat && selectedTicketId ? 'hidden lg:flex' : 'flex'} h-[50vh] lg:h-full">
        <div class="flex items-center gap-1.5 mb-4 overflow-x-auto pb-2 scrollbar-hide">
          {#each ['ALL', 'OPEN', 'CLAIMED', 'CLOSED'] as filterType}
            <button
              onclick={() => ticketFilter = filterType as any}
              class="px-3 py-1.5 rounded-full text-xs font-medium transition-all whitespace-nowrap {ticketFilter === filterType ? 'bg-primary text-white shadow-md shadow-primary/20' : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'}"
            >
              {filterType === 'ALL' ? 'Tous' : getStatusLabel(filterType)}
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
              <p class="text-xs font-bold">Aucun ticket trouvé</p>
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
                      <p class="text-sm font-semibold text-on-surface truncate">@{ticket.username || 'Anonyme'}</p>
                      <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider border shrink-0 {getStatusColor(ticket.status)}">
                        {getStatusLabel(ticket.status)}
                      </span>
                    </div>
                    {#if ticket.reason}
                      <p class="text-[11px] text-on-surface-variant/70 mt-0.5 truncate">{ticket.reason}</p>
                    {/if}
                    <p class="text-[10px] text-on-surface-variant/40 mt-0.5">{new Date(ticket.createdAt).toLocaleDateString('fr-FR')}</p>
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
            <h3 class="text-lg font-semibold text-on-surface/40">Aucun ticket sélectionné</h3>
            <p class="text-xs opacity-60 mt-1">Sélectionnez un ticket pour démarrer.</p>
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
                  <h3 class="text-sm lg:text-base font-semibold text-on-surface truncate">@{selectedTicketDetail?.username || 'Utilisateur'}</h3>
                  <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider border {getStatusColor(selectedTicketDetail?.status)}">
                    {getStatusLabel(selectedTicketDetail?.status)}
                  </span>
                  {#if selectedTicketDetail?.mode && selectedTicketDetail.mode !== 'CHANNEL'}
                    <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider bg-blue-500/10 text-blue-400 border border-blue-500/20">
                      {selectedTicketDetail.mode === 'DM' ? 'MP' : 'Thread'}
                    </span>
                  {/if}
                </div>
                {#if selectedTicketDetail?.claimedByName}
                  <div class="flex items-center gap-1 text-[10px] text-primary/80 font-bold">
                    {#if selectedTicketDetail.claimedByAvatar}
                      <img src={selectedTicketDetail.claimedByAvatar} alt={selectedTicketDetail.claimedByName} class="w-4 h-4 rounded-full object-cover" />
                    {/if}
                    Assigné à @{selectedTicketDetail.claimedByName}
                  </div>
                {/if}
              </div>
            </div>

            <!-- Quick actions — scrollable on mobile -->
            <div class="flex items-center gap-2 mt-3 overflow-x-auto pb-1 scrollbar-hide">
              <button
                onclick={() => openMemberCase(selectedTicketDetail.userId, selectedTicketDetail.username)}
                class="px-3 py-1.5 bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded-lg text-[10px] font-semibold uppercase tracking-wider hover:bg-indigo-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
              >
                <Papicon icon="shield" size={12} /> Casier
              </button>

              {#if selectedTicketDetail?.status === 'OPEN'}
                {#if selectedTicketDetail.claimedBy !== authStore.user?.id}
                  <button onclick={claimTicket}
                    class="px-3 py-1.5 bg-amber-500/10 text-amber-500 border border-amber-500/20 rounded-lg text-[10px] font-semibold uppercase tracking-wider hover:bg-amber-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
                  >
                    <Papicon icon="user-check" size={12} /> S'assigner
                  </button>
                {/if}
                <button onclick={() => showCloseModal = true}
                  class="px-3 py-1.5 bg-rose-500/10 text-rose-500 border border-rose-500/20 rounded-lg text-[10px] font-semibold uppercase tracking-wider hover:bg-rose-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
                >
                  <Papicon icon="x-circle" size={12} /> Fermer
                </button>
              {/if}

              {#if selectedTicketDetail?.status === 'CLAIMED' && selectedTicketDetail.claimedById !== authStore.user?.id && (config.ticketAllowOverclaim ?? true) && config.ticketOverclaimPermission !== 'NONE'}
                <button onclick={claimTicket}
                  class="px-3 py-1.5 bg-amber-500/10 text-amber-500 border border-amber-500/20 rounded-lg text-[10px] font-semibold uppercase tracking-wider hover:bg-amber-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
                >
                  <Papicon icon="user-check" size={12} /> Sur-revendiquer
                </button>
              {/if}

              {#if selectedTicketDetail?.status === 'CLOSED'}
                {#if selectedTicketDetail.channelId}
                  <button onclick={reopenTicket}
                    class="px-3 py-1.5 bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 rounded-lg text-[10px] font-semibold uppercase tracking-wider hover:bg-emerald-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
                  >
                    <Papicon icon="refresh" size={12} /> Réouvrir
                  </button>
                  <button onclick={() => showDeleteConfirmModal = true}
                    class="px-3 py-1.5 bg-rose-600 text-white rounded-lg text-[10px] font-semibold uppercase tracking-wider active:scale-[0.98] transition-all flex items-center gap-1.5 shrink-0"
                  >
                    <Papicon icon="delete" size={12} /> Supprimer
                  </button>
                {/if}
                {#if selectedTicketDetail?.transcriptId}
                  {@const restoresLeft = 3 - (selectedTicketDetail.restoreCount ?? 0)}
                  <button
                    onclick={() => { if (restoresLeft > 0) showRestoreModal = true; }}
                    disabled={restoresLeft <= 0}
                    title={restoresLeft <= 0 ? 'Limite de restauration atteinte (3/3). Ce ticket ne peut plus être restauré.' : `${restoresLeft} restauration${restoresLeft > 1 ? 's' : ''} restante${restoresLeft > 1 ? 's' : ''}`}
                    class="px-3 py-1.5 rounded-lg text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1.5 shrink-0 transition-all {restoresLeft > 0 ? 'bg-purple-500/10 text-purple-400 border border-purple-500/20 hover:bg-purple-500 hover:text-white cursor-pointer' : 'bg-surface-container text-on-surface-variant/30 border border-outline-variant/10 cursor-not-allowed'}"
                  >
                    <Papicon icon="refresh-ccw" size={12} /> Restaurer ({restoresLeft}/3)
                  </button>
                {/if}
              {/if}

              {#if selectedTicketDetail?.transcriptId}
                <a href="/transcripts/{selectedTicketDetail.transcriptId}" target="_blank"
                  class="px-3 py-1.5 bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-lg text-[10px] font-semibold uppercase tracking-wider hover:bg-blue-500 hover:text-white transition-all flex items-center gap-1.5 shrink-0"
                >
                  <Papicon icon="external-link" size={12} /> Transcription originale
                </a>
              {/if}
            </div>

            {#if selectedTicketDetail?.channelId && selectedTicketDetail?.mode !== 'DM'}
              <div class="mt-3 flex gap-2 items-center">
                <FormInput type="text" bind:value={ticketRenameName} placeholder="ticket-nouveau-nom" className="flex-1" />
                <button onclick={renameTicket} disabled={renameAction.state.loading || !ticketRenameName.trim()}
                  class="px-3 py-2.5 bg-primary text-white rounded-lg text-[10px] font-semibold uppercase tracking-wider disabled:opacity-50 flex items-center gap-1.5 shrink-0"
                >
                  <Papicon icon="edit" size={12} />
                  {renameAction.state.loading ? '...' : 'Renommer'}
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
                  title="Transcription du Ticket"
                  class="w-full h-full border-none bg-[#313338]"
                ></iframe>
              {:else}
                <div class="flex flex-col items-center justify-center text-white/30 h-full">
                  <Papicon icon="forum" size={28} class="opacity-50 mb-2" />
                  <p class="text-xs">Aucun message dans ce ticket.</p>
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
                      <span class="text-xs lg:text-sm font-bold text-white">{msg.authorName || 'Anonyme'}</span>
                      {#if msg.isStaff}
                        <span class="bg-[#5865F2] text-white text-[9px] lg:text-[11px] font-semibold uppercase px-1 py-0.5 rounded tracking-wider leading-none">Staff</span>
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
                                <!-- svelte-ignore a11y_media_has_caption -->
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
                              <Papicon icon="file" size={14} /> Pièce jointe
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
                placeholder="Écrire un message..."
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
              <Papicon icon="lock" size={14} /> Ticket fermé
            </div>
          {/if}
        {/if}
      </div>

    </div>
  {:else if activeTab === 'config'}
    <!-- Configuration Panel — redesigned sections -->
    <div class="max-w-4xl mx-auto space-y-4">

      <!-- Header actions -->
      <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pb-2">
        <div>
          <h3 class="text-lg font-semibold text-on-surface">Configuration des Tickets</h3>
          <p class="text-on-surface-variant text-xs mt-0.5">Mode de fonctionnement, salons, embed et types de tickets.</p>
        </div>
        <button
          onclick={sendEmbedPanel}
          disabled={sendEmbedAction.state.loading || !ticketChannelId}
          class="px-4 py-2.5 bg-primary text-white rounded-xl text-[10px] font-semibold uppercase tracking-wider active:scale-[0.98] transition-transform disabled:opacity-50 flex items-center gap-2 shrink-0"
        >
          <Papicon icon="send" size={13} />
          {sendEmbedAction.state.loading ? 'Envoi...' : 'Envoyer Embed'}
        </button>
      </div>

      <!-- ─── Section 1: Salons & Rôles ──────────────────────────────────── -->
      <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 overflow-hidden">
        <button onclick={() => toggleConfigSection('channels')} class="w-full flex items-center justify-between p-4 lg:p-5 hover:bg-white/3 transition-colors text-left">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center shrink-0">
              <Papicon icon="hash" size={18} />
            </div>
            <div>
              <p class="text-sm font-semibold text-on-surface">Salons & Rôles</p>
              <p class="text-[10px] text-on-surface-variant/60 mt-0.5">Catégorie par défaut, logs, relais MP, rôle staff et sur-revendication</p>
            </div>
          </div>
          <Papicon icon={expandedConfigSection === 'channels' ? 'chevron-up' : 'chevron-down'} size={16} class="text-on-surface-variant/40 shrink-0" />
        </button>
        {#if expandedConfigSection === 'channels'}
          <div class="px-4 lg:px-5 pb-5 space-y-4 border-t border-outline-variant/10 pt-4">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Catégorie des tickets par défaut</span>
                <SearchableSelect bind:value={ticketCategoryId} options={discordCategories.map(c => ({ id: c.id, name: c.name }))} placeholder="Sélectionner" className="w-full" />
              </label>
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Salon du panel d'ouverture</span>
                <SearchableSelect bind:value={ticketChannelId} options={discordChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))} placeholder="Sélectionner" className="w-full" />
              </label>
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Salon des logs / transcripts</span>
                <SearchableSelect bind:value={ticketLogChannelId} options={discordChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))} placeholder="Sélectionner" className="w-full" />
              </label>
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Rôle Staff Support par défaut</span>
                <SearchableSelect bind:value={ticketStaffRoleId} options={discordRoles.map(r => ({ id: r.id, name: `@${r.name}` }))} placeholder="Sélectionner" className="w-full" />
              </label>
              <label class="block col-span-1 md:col-span-2">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Salon de relais des messages privés (Mode MP)</span>
                <SearchableSelect bind:value={ticketDmRelayChannelId} options={discordChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))} placeholder="Sélectionner un salon" className="w-full" />
              </label>
            </div>

            <div class="border-t border-outline-variant/10 pt-4 space-y-3">
              <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
                <input type="checkbox" bind:checked={ticketAllowOverclaim} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
                <div>
                  <span class="text-xs font-bold text-on-surface">Autoriser la sur-revendication</span>
                  <p class="text-[10px] text-on-surface-variant/60">Un staff peut reprendre un ticket déjà revendiqué.</p>
                </div>
              </label>
              {#if ticketAllowOverclaim}
                <label class="block ml-7">
                  <span class="text-xs font-bold text-on-surface-variant/80 mb-2 block">Qui peut sur-revendiquer ?</span>
                  <FormSelect bind:value={ticketOverclaimPermission} className="w-full">
                    <option value="ANY">Tout le staff</option>
                    <option value="SUPERIOR_OR_EQUAL">Grade supérieur ou égal</option>
                  </FormSelect>
                </label>
              {/if}
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
              <p class="text-sm font-semibold text-on-surface">Personnalisation de l'Embed</p>
              <p class="text-[10px] text-on-surface-variant/60 mt-0.5">Titre, description, couleur et texte du bouton</p>
            </div>
          </div>
          <Papicon icon={expandedConfigSection === 'embed' ? 'chevron-up' : 'chevron-down'} size={16} class="text-on-surface-variant/40 shrink-0" />
        </button>
        {#if expandedConfigSection === 'embed'}
          <div class="px-4 lg:px-5 pb-5 space-y-4 border-t border-outline-variant/10 pt-4">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Titre</span>
                <FormInput type="text" bind:value={ticketEmbedTitle} placeholder="Support Client" className="w-full" />
              </label>
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Texte du bouton</span>
                <FormInput type="text" bind:value={ticketEmbedButtonText} placeholder="Ouvrir un ticket" className="w-full" />
              </label>
            </div>
            <label class="block">
              <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Description</span>
              <FormTextarea bind:value={ticketEmbedDesc} placeholder="Cliquez pour obtenir de l'aide..." className="w-full h-20" />
            </label>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Miniature (Thumbnail URL)</span>
                <FormInput type="text" bind:value={ticketEmbedThumbnail} placeholder="https://..." className="w-full" />
              </label>
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Grande Image (Image URL)</span>
                <FormInput type="text" bind:value={ticketEmbedImage} placeholder="https://..." className="w-full" />
              </label>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Auteur - Nom</span>
                <FormInput type="text" bind:value={ticketEmbedAuthorName} placeholder="Kotbo Support" className="w-full" />
              </label>
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Auteur - Icône (URL)</span>
                <FormInput type="text" bind:value={ticketEmbedAuthorIcon} placeholder="https://..." className="w-full" />
              </label>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Couleur</span>
                <FormColorPicker bind:value={ticketEmbedColor} />
              </label>
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Texte de bas de page (Footer)</span>
                <FormInput type="text" bind:value={ticketEmbedFooter} placeholder="Kotbo • Système de tickets" className="w-full" />
              </label>
            </div>

            <div class="border-t border-outline-variant/10 pt-4">
              <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-3 block">Type d'interaction</span>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {#each [
                  { value: 'BUTTONS', label: 'Boutons', icon: 'mouse-pointer', desc: 'Un bouton par type de ticket, directement dans l\'embed' },
                  { value: 'DROPDOWN', label: 'Menu déroulant', icon: 'list', desc: 'Un menu déroulant unique avec tous les types de tickets' }
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
              <p class="text-sm font-semibold text-on-surface">Message d'accueil dans le ticket</p>
              <p class="text-[10px] text-on-surface-variant/60 mt-0.5">Personnaliser l'embed/container envoyé lors de la création du ticket</p>
            </div>
          </div>
          <Papicon icon={expandedConfigSection === 'welcome' ? 'chevron-up' : 'chevron-down'} size={16} class="text-on-surface-variant/40 shrink-0" />
        </button>
        {#if expandedConfigSection === 'welcome'}
          <div class="px-4 lg:px-5 pb-5 space-y-4 border-t border-outline-variant/10 pt-4">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label class="block col-span-1 md:col-span-2">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Titre (Placeholders : {'{type_label}'})</span>
                <FormInput type="text" bind:value={ticketWelcomeTitle} placeholder="🎫 Ticket d'Assistance · {'{type_label}'}" className="w-full" />
              </label>
            </div>
            <label class="block">
              <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Description (Placeholders : {'{user}'}, {'{staff_mention}'}, {'{reason}'}, {'{description}'})</span>
              <FormTextarea bind:value={ticketWelcomeDesc} placeholder="Bonjour {'{user}'} !\nLe personnel {'{staff_mention}'} va prendre en charge..." className="w-full h-32" />
            </label>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Miniature (Thumbnail URL)</span>
                <FormInput type="text" bind:value={ticketWelcomeThumbnail} placeholder="https://..." className="w-full" />
              </label>
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Grande Image (Image URL)</span>
                <FormInput type="text" bind:value={ticketWelcomeImage} placeholder="https://..." className="w-full" />
              </label>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Couleur de l'embed</span>
                <FormColorPicker bind:value={ticketWelcomeColor} />
              </label>
              <label class="block">
                <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Texte de bas de page (Footer)</span>
                <FormInput type="text" bind:value={ticketWelcomeFooter} placeholder="Kotbo · Ticket ID: {'{ticket_id}'}" className="w-full" />
              </label>
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
              <p class="text-sm font-semibold text-on-surface">Inactivité</p>
              <p class="text-[10px] text-on-surface-variant/60 mt-0.5">Rappel automatique si le créateur ne répond pas</p>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            {#if ticketInactivityEnabled}
              <span class="px-2 py-0.5 rounded-full text-[9px] font-semibold uppercase bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">Actif</span>
            {/if}
            <Papicon icon={expandedConfigSection === 'inactivity' ? 'chevron-up' : 'chevron-down'} size={16} class="text-on-surface-variant/40" />
          </div>
        </button>
        {#if expandedConfigSection === 'inactivity'}
          <div class="px-4 lg:px-5 pb-5 space-y-4 border-t border-outline-variant/10 pt-4">
            <label class="flex items-center gap-3 cursor-pointer p-2.5 hover:bg-white/5 rounded-xl transition-colors">
              <input type="checkbox" bind:checked={ticketInactivityEnabled} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
              <div>
                <span class="text-xs font-bold text-on-surface">Activer les rappels</span>
                <p class="text-[10px] text-on-surface-variant/60">Message automatique après inactivité du créateur.</p>
              </div>
            </label>
            {#if ticketInactivityEnabled}
              <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <label class="block">
                  <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Délai (heures)</span>
                  <input type="number" bind:value={ticketInactivityHours} min={1} max={168} class="w-full bg-surface-container-high text-sm px-4 py-2.5 rounded-xl border border-outline-variant/10 focus:ring-1 ring-primary/30 transition-all outline-none" />
                </label>
                <label class="block sm:col-span-2">
                  <span class="text-xs font-bold text-on-surface-variant/80 ml-1 mb-2 block">Message ({'{user}'} = mention)</span>
                  <FormTextarea bind:value={ticketInactivityMessage} placeholder="Bonjour {'{user}'}, votre ticket est inactif..." className="w-full h-20" />
                </label>
              </div>
            {/if}
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
              <p class="text-sm font-semibold text-on-surface">Types de tickets</p>
              <p class="text-[10px] text-on-surface-variant/60 mt-0.5">{ticketTypes.length} type{ticketTypes.length > 1 ? 's' : ''} — configurez les boutons, salons, rôles et formulaires par type de ticket</p>
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
                <Papicon icon="plus" size={13} /> Ajouter un type
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
                            <span class="px-1.5 py-0.5 rounded text-[8px] font-semibold tracking-wider uppercase bg-blue-500/10 text-blue-400 border border-blue-500/15">Salon</span>
                          {:else if ticketType.mode === 'DM'}
                            <span class="px-1.5 py-0.5 rounded text-[8px] font-semibold tracking-wider uppercase bg-purple-500/10 text-purple-400 border border-purple-500/15">Message Privé</span>
                          {:else if ticketType.mode === 'THREAD'}
                            <span class="px-1.5 py-0.5 rounded text-[8px] font-semibold tracking-wider uppercase bg-amber-500/10 text-amber-400 border border-amber-500/15">Thread</span>
                          {:else}
                            <span class="px-1.5 py-0.5 rounded text-[8px] font-semibold tracking-wider uppercase bg-surface-container-high text-on-surface-variant/60 border border-outline-variant/10">Mode global</span>
                          {/if}

                          <!-- Staff Role Badge -->
                          {#if ticketType.staffRoleId}
                            {@const role = discordRoles.find(r => r.id === ticketType.staffRoleId)}
                            <span class="px-1.5 py-0.5 rounded text-[8px] font-semibold tracking-wider bg-emerald-500/10 text-emerald-400 border border-emerald-500/15">Staff: @{role?.name || 'Inconnu'}</span>
                          {:else}
                            <span class="px-1.5 py-0.5 rounded text-[8px] font-semibold tracking-wider bg-surface-container-high text-on-surface-variant/40 border border-outline-variant/10">Staff hérité</span>
                          {/if}

                          <!-- Form Enabled Badge -->
                          {#if ticketType.formEnabled}
                            <span class="px-1.5 py-0.5 rounded text-[8px] font-semibold tracking-wider bg-indigo-500/10 text-indigo-400 border border-indigo-500/15">Avec Formulaire ({(ticketType.formCustomFields || []).length} question{(ticketType.formCustomFields || []).length > 1 ? 's' : ''})</span>
                          {:else}
                            <span class="px-1.5 py-0.5 rounded text-[8px] font-semibold tracking-wider bg-surface-container-high text-on-surface-variant/40 border border-outline-variant/10">Création Directe</span>
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
                        title="Monter"
                      >
                        <Papicon icon="arrow-up" size={13} />
                      </button>
                      <button
                        onclick={() => moveTicketType(index, 'DOWN')}
                        disabled={index === ticketTypes.length - 1}
                        class="p-1.5 rounded-lg border border-outline-variant/10 text-on-surface-variant hover:bg-white/5 disabled:opacity-30 transition-colors"
                        title="Descendre"
                      >
                        <Papicon icon="arrow-down" size={13} />
                      </button>

                      <div class="w-px h-5 bg-outline-variant/10 mx-1"></div>

                      <!-- Edit expansion toggle button -->
                      <button
                        onclick={() => expandedTicketTypeIndex = isExpanded ? null : index}
                        class="px-2.5 py-1.5 rounded-lg border text-[9px] font-semibold uppercase tracking-wider transition-colors {isExpanded ? 'bg-primary text-white border-primary' : 'bg-surface-container text-on-surface hover:bg-white/5 border-outline-variant/10'}"
                      >
                        {isExpanded ? 'Fermer' : 'Modifier'}
                      </button>

                      <!-- Delete button -->
                      <button
                        onclick={() => removeTicketType(index)}
                        class="p-1.5 rounded-lg bg-rose-500/10 text-rose-500 hover:bg-rose-500 hover:text-white border border-rose-500/15 transition-all"
                        title="Supprimer"
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
                          <span class="text-[10px] font-bold text-on-surface-variant/70 ml-1 mb-1.5 block">Libellé du Bouton / Option</span>
                          <FormInput type="text" bind:value={ticketType.label} placeholder="Support technique" className="w-full" />
                        </label>
                        <div class="grid grid-cols-2 gap-3">
                          <label class="block">
                            <span class="text-[10px] font-bold text-on-surface-variant/70 ml-1 mb-1.5 block">Emoji</span>
                            <div class="flex gap-1.5">
                              <FormInput type="text" bind:value={ticketType.emoji} placeholder="📩" className="w-full" />
                              <EmojiPicker bind:value={ticketType.emoji} />
                            </div>
                          </label>
                          <label class="block">
                            <span class="text-[10px] font-bold text-on-surface-variant/70 ml-1 mb-1.5 block">Couleur bouton (Style)</span>
                            <FormSelect bind:value={ticketType.buttonStyle} className="w-full">
                              <option value="PRIMARY">Bleu (Primaire)</option>
                              <option value="SECONDARY">Gris (Secondaire)</option>
                              <option value="SUCCESS">Vert (Succès)</option>
                              <option value="DANGER">Rouge (Danger)</option>
                            </FormSelect>
                          </label>
                        </div>
                      </div>

                      <label class="block">
                        <span class="text-[10px] font-bold text-on-surface-variant/70 ml-1 mb-1.5 block">Description de l'option (menu déroulant)</span>
                        <FormTextarea bind:value={ticketType.description} placeholder="Sélectionnez cette option si vous rencontrez un problème..." className="w-full h-16" />
                      </label>

                      <!-- Salons & Rôles targets -->
                      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <label class="block">
                          <span class="text-[10px] font-bold text-on-surface-variant/70 ml-1 mb-1.5 block">Mode d'ouverture</span>
                          <FormSelect bind:value={ticketType.mode} className="w-full">
                            <option value="">Par défaut (global)</option>
                            <option value="CHANNEL">Nouveau Salon</option>
                            <option value="DM">Messages Privés (MP)</option>
                            <option value="THREAD">Thread (Fil de discussion)</option>
                          </FormSelect>
                        </label>
                        <label class="block">
                          <span class="text-[10px] font-bold text-on-surface-variant/70 ml-1 mb-1.5 block">Catégorie cible (Salons / Threads)</span>
                          <SearchableSelect bind:value={ticketType.categoryId} options={discordCategories.map(c => ({ id: c.id, name: c.name }))} placeholder="Sélectionner (hérité par défaut)" className="w-full" />
                        </label>
                        <label class="block">
                          <span class="text-[10px] font-bold text-on-surface-variant/70 ml-1 mb-1.5 block">Rôle Staff spécifique</span>
                          <SearchableSelect bind:value={ticketType.staffRoleId} options={discordRoles.map(r => ({ id: r.id, name: `@${r.name}` }))} placeholder="Sélectionner (hérité par défaut)" className="w-full" />
                        </label>
                      </div>

                      <!-- Toggle Options -->
                      {#if ticketType.mode === 'DM' || (ticketType.mode === '' && ticketMode === 'DM')}
                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                          <div class="flex items-center gap-2.5 p-1">
                            <ToggleSwitch checked={ticketType.anonymous} onToggle={(v) => { ticketType.anonymous = v; }} size="sm" />
                            <div>
                              <span class="text-xs font-semibold text-on-surface">Anonymat du Staff</span>
                              <p class="text-[10px] text-on-surface-variant/50 leading-none mt-0.5">Masque l'identité du staff en mode MP</p>
                            </div>
                          </div>
                          <div class="flex items-center gap-2.5 p-1">
                            <ToggleSwitch checked={ticketType.staffServerRelay} onToggle={(v) => { ticketType.staffServerRelay = v; }} size="sm" />
                            <div>
                              <span class="text-xs font-semibold text-on-surface">Créer le fil sur le serveur staff</span>
                              <p class="text-[10px] text-on-surface-variant/50 leading-none mt-0.5">Pour le mode MP / relais staff externe</p>
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
                              <span class="text-xs font-semibold text-on-surface">Créer le salon sur le serveur staff</span>
                              <p class="text-[10px] text-on-surface-variant/50 leading-none mt-0.5">Ticket interne (RH, plainte...) hébergé sur {staffServerInfo.staffGuildName}</p>
                            </div>
                          </div>
                          {#if ticketType.staffServerChannel}
                            <label class="block">
                              <span class="text-[10px] font-bold text-on-surface-variant/70 ml-1 mb-1.5 block">Catégorie sur le serveur staff</span>
                              <SearchableSelect bind:value={ticketType.staffServerCategoryId} options={staffServerInfo.categories.map((c: any) => ({ id: c.id, name: c.name }))} placeholder="Sélectionner une catégorie" className="w-full" />
                            </label>
                          {/if}
                        </div>
                      {/if}

                      <!-- Modal Form Configurator -->
                      <div class="pt-4 border-t border-outline-variant/10 mt-3">
                        <label class="flex items-center gap-3 cursor-pointer p-1 rounded-xl transition-colors">
                          <input type="checkbox" bind:checked={ticketType.formEnabled} class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/30" />
                          <div>
                            <span class="text-xs font-bold text-on-surface">Activer le formulaire de questions pour ce type</span>
                            <p class="text-[10px] text-on-surface-variant/60">Affiche une pop-up de questions lors du clic.</p>
                          </div>
                        </label>

                        {#if ticketType.formEnabled}
                          <div class="space-y-4 pt-4 pl-7">
                            <div class="flex items-center justify-between">
                              <span class="text-xs font-bold text-on-surface-variant/80">Questions personnalisées (Maximum 5)</span>
                              <button
                                onclick={() => addCustomField(index)}
                                disabled={(ticketType.formCustomFields || []).length >= 5}
                                class="px-2 py-1 bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-40 rounded-lg text-[9px] font-semibold uppercase tracking-wider transition-colors flex items-center gap-1"
                              >
                                <Papicon icon="plus" size={11} /> Ajouter une question
                              </button>
                            </div>

                            {#if !(ticketType.formCustomFields || []).length}
                              <div class="p-4 rounded-xl border border-dashed border-outline-variant/20 bg-surface-container/10 text-center">
                                <p class="text-xs text-on-surface-variant/60">Aucune question configurée pour ce type.</p>
                                <p class="text-[10px] text-on-surface-variant/40 mt-1">Le modal utilisera par défaut : "Sujet" et "Description".</p>
                              </div>
                            {:else}
                              <div class="space-y-3">
                                {#each ticketType.formCustomFields as field, fieldIndex}
                                  <div class="p-3 rounded-lg border border-outline-variant/10 bg-surface-container/10 space-y-3 relative group">
                                    <div class="flex items-center justify-between">
                                      <span class="text-[10px] font-bold text-primary">Question #{fieldIndex + 1}</span>
                                      <button
                                        onclick={() => removeCustomField(index, field.id)}
                                        class="text-rose-500 hover:text-rose-400 p-1 rounded-lg hover:bg-rose-500/10 transition-colors"
                                      >
                                        <Papicon icon="trash-2" size={13} />
                                      </button>
                                    </div>

                                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                      <label class="block">
                                        <span class="text-[9px] font-bold text-on-surface-variant/70 mb-1 block">Question / Label</span>
                                        <FormInput type="text" bind:value={field.label} placeholder="Quel est votre problème ?" className="w-full" />
                                      </label>
                                      <label class="block">
                                        <span class="text-[9px] font-bold text-on-surface-variant/70 mb-1 block">Indication / Placeholder</span>
                                        <FormInput type="text" bind:value={field.placeholder} placeholder="Détaillez ici..." className="w-full" />
                                      </label>
                                    </div>

                                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                      <label class="block">
                                        <span class="text-[9px] font-bold text-on-surface-variant/70 mb-1 block">Type de réponse</span>
                                        <FormSelect bind:value={field.style} className="w-full">
                                          <option value="SHORT">Ligne courte (ex: Nom, Pseudo) [Modal]</option>
                                          <option value="PARAGRAPH">Paragraphe long (ex: Description) [Modal]</option>
                                          <option value="SELECT">Menu déroulant (ex: Catégories) [Interactif]</option>
                                          <option value="RADIO">Boutons radios (ex: Oui/Non) [Interactif]</option>
                                          <option value="FILE">Fichier joint (ex: Capture d'écran) [Interactif]</option>
                                        </FormSelect>
                                      </label>
                                      <label class="flex items-center gap-2 cursor-pointer pt-5">
                                        <input type="checkbox" bind:checked={field.required} class="w-3.5 h-3.5 rounded text-primary focus:ring-primary border-outline-variant/30" />
                                        <span class="text-[9px] font-bold text-on-surface">Champ obligatoire</span>
                                      </label>
                                    </div>

                                    {#if field.style === 'SELECT' || field.style === 'RADIO'}
                                      <div class="pt-1">
                                        <label class="block">
                                          <span class="text-[9px] font-bold text-on-surface-variant/70 mb-1 block">Choix / Options (séparés par des virgules)</span>
                                          <FormInput
                                            type="text"
                                            bind:value={field.choicesString}
                                            placeholder="Choix A, Choix B, Choix C"
                                            className="w-full"
                                            oninput={() => {
                                              field.choices = field.choicesString ? field.choicesString.split(',').map(s => s.trim()).filter(Boolean) : [];
                                            }}
                                          />
                                        </label>
                                      </div>
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
  {:else if activeTab === 'transcripts'}
    <div class="bg-surface-container-low/40 border border-outline-variant/10 rounded-xl p-4 lg:p-6 flex flex-col min-h-[40vh]">
      <div class="mb-4">
        <h3 class="text-lg font-semibold text-on-surface">Transcriptions</h3>
        <p class="text-on-surface-variant text-xs mt-0.5">Historique des transcriptions de tickets et de salons.</p>
      </div>

      {#if loading}
        <div class="flex items-center justify-center py-16">
          <div class="w-8 h-8 rounded-full border-4 border-primary border-t-transparent animate-spin"></div>
        </div>
      {:else if transcripts.length === 0}
        <div class="flex flex-col items-center justify-center py-16 text-on-surface-variant/30">
          <Papicon icon="inbox" size={36} class="opacity-50 mb-2" />
          <p class="text-xs font-bold">Aucune transcription</p>
        </div>
      {:else}
        <!-- Mobile: card layout / Desktop: table -->
        <div class="hidden md:block overflow-x-auto w-full">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-outline-variant/15 text-xs font-medium text-on-surface-variant/70">
                <th class="py-3 px-4">Salon</th>
                <th class="py-3 px-4">Type</th>
                <th class="py-3 px-4">Période</th>
                <th class="py-3 px-4">Généré le</th>
                <th class="py-3 px-4 text-right">Action</th>
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
                      <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase bg-blue-500/10 text-blue-400 border border-blue-500/20">Ticket</span>
                    {:else}
                      <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">/transcript</span>
                    {/if}
                  </td>
                  <td class="py-3 px-4 text-xs text-on-surface-variant">
                    {#if t.startTime && t.endTime}
                      {new Date(t.startTime).toLocaleDateString('fr-FR')} — {new Date(t.endTime).toLocaleDateString('fr-FR')}
                    {:else}
                      <span class="text-on-surface-variant/40 italic">Toutes</span>
                    {/if}
                  </td>
                  <td class="py-3 px-4 text-xs text-on-surface-variant">
                    {new Date(t.createdAt).toLocaleDateString('fr-FR')}
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
                  <span class="px-2 py-0.5 rounded-full text-[9px] font-semibold uppercase bg-blue-500/10 text-blue-400 border border-blue-500/20 shrink-0">Ticket</span>
                {:else}
                  <span class="px-2 py-0.5 rounded-full text-[9px] font-semibold uppercase bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">/transcript</span>
                {/if}
              </div>
              <p class="text-[10px] text-on-surface-variant/60 mb-2">
                {new Date(t.createdAt).toLocaleDateString('fr-FR')}
                {#if t.startTime && t.endTime}
                  — Du {new Date(t.startTime).toLocaleDateString('fr-FR')} au {new Date(t.endTime).toLocaleDateString('fr-FR')}
                {/if}
              </p>
              <a href="/transcripts/{t.id}" target="_blank"
                class="px-3 py-1.5 bg-primary/10 text-primary border border-primary/20 rounded-lg text-[10px] font-semibold uppercase tracking-wider hover:bg-primary hover:text-white transition-all inline-flex items-center gap-1"
              >
                <Papicon icon="external-link" size={11} /> Consulter
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
          <p class="sat-avg-label">{satisfactionData.global.totalResponses} réponses</p>

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
          <h3 class="sat-card-title">Satisfaction par Staff</h3>
          {#if satisfactionData.byStaff.length === 0}
            <p class="sat-empty">Aucune donnee par staff.</p>
          {:else}
            <div class="sat-staff-list">
              {#each satisfactionData.byStaff as staff}
                <button type="button" class="sat-staff-row sat-clickable-person" onclick={() => openSatisfactionMember(staff.staffId, staff.staff)}>
                  <span class="sat-person-main">
                    {#if staff.staff?.avatarUrl}
                      <img src={staff.staff.avatarUrl} alt="" class="sat-person-avatar" />
                    {:else}
                      <span class="sat-person-avatar sat-avatar-fallback">{getSatisfactionInitials(staff.staff, staff.staffId)}</span>
                    {/if}
                    <span class="sat-person-text">
                      <span class="sat-person-name">{getSatisfactionPersonName(staff.staff, staff.staffId)}</span>
                      <span class="sat-person-handle">{getSatisfactionPersonHandle(staff.staff, staff.staffId)}</span>
                    </span>
                  </span>
                  <div class="sat-staff-rating" style="color: {getRatingColor(staff.averageRating)}">
                    {staff.averageRating.toFixed(1)}/5
                  </div>
                  <span class="sat-staff-count">({staff.totalResponses} avis)</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>

        <!-- Recent Reviews Card -->
        <div class="sat-card sat-recent-card">
          <h3 class="sat-card-title">Avis recents</h3>
          {#if satisfactionData.global.recent.length === 0}
            <p class="sat-empty">Aucun avis pour le moment.</p>
          {:else}
            <div class="sat-recent-list">
              {#each satisfactionData.global.recent.slice(0, 15) as review}
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
                  {#if review.comment}
                    <span class="sat-review-comment">"{review.comment}"</span>
                  {/if}
                  <span class="sat-review-date">{new Date(review.createdAt).toLocaleDateString('fr-FR')}</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    {:else}
      <div class="flex flex-col items-center justify-center py-16 text-on-surface-variant/30">
        <Papicon icon="smile" size={36} class="opacity-50 mb-2" />
        <p class="text-xs font-bold">Aucune donnee de satisfaction</p>
      </div>
    {/if}
  {/if}
</ModulePage>

<!-- ============================================== -->
<!-- MODALS -->
<!-- ============================================== -->

<!-- Ticket Close Modal -->
{#if showCloseModal}
  <div class="fixed inset-0 z-100 flex items-center justify-center p-4 bg-black/60">
    <div class="bg-surface border border-outline-variant/30 rounded-xl w-full max-w-lg shadow-sm p-10 animate-in zoom-in-95 duration-300">
      <div class="flex items-center gap-4 mb-2 text-rose-500">
        <Papicon icon="x-circle" size={36} />
        <h3 class="text-2xl font-semibold">Clôturer le Ticket</h3>
      </div>
      <p class="text-sm text-on-surface-variant/80 mb-6">Cette action fermera le salon de ticket. Vous pourrez y ajouter un motif de fermeture.</p>
      
      <div>
        <label for="close-reason-input" class="field-label">Raison de la fermeture (Optionnel)</label>
        <textarea id="close-reason-input" bind:value={closeReason} class="w-full h-32 bg-surface-container rounded-lg p-4 focus:outline-hidden border-2 border-transparent focus:border-primary/50 text-sm" placeholder="Raison de la fermeture..."></textarea>
      </div>
      
      <div class="flex gap-4 mt-8 pt-6 border-t border-outline-variant/20">
        <button onclick={() => showCloseModal = false} class="flex-1 py-4 rounded-xl font-bold bg-surface-container hover:bg-surface-container-high transition-colors">Annuler</button>
        <button 
          onclick={closeTicket} 
          class="flex-1 py-4 rounded-xl font-bold bg-rose-600 text-white active:scale-[0.98] transition-transform shadow-sm"
        >
          Confirmer la fermeture
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
        <h3 class="text-2xl font-semibold">Supprimer définitivement ?</h3>
      </div>
      <p class="text-sm text-on-surface-variant/80 mb-6">Cette action va supprimer définitivement le salon sur Discord et générer une transcription autonome Kotbo.</p>
      
      <div class="flex gap-4 mt-8 pt-6 border-t border-outline-variant/20">
        <button onclick={() => showDeleteConfirmModal = false} class="flex-1 py-4 rounded-xl font-bold bg-surface-container hover:bg-surface-container-high transition-colors">Annuler</button>
        <button 
          onclick={deleteTicket} 
          class="flex-1 py-4 rounded-xl font-bold bg-rose-600 text-white active:scale-[0.98] transition-transform shadow-sm"
        >
          Confirmer la suppression
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
        <h3 class="text-2xl font-semibold">Restaurer le Ticket</h3>
      </div>
      <p class="text-sm text-on-surface-variant/80 mb-4">Cette action va :</p>
      <ul class="text-sm text-on-surface-variant/80 mb-6 space-y-2 list-disc ml-5">
        <li>Créer un <strong>nouveau salon</strong> de ticket sur Discord</li>
        <li>Rejouer tout l'<strong>historique des messages et embeds</strong> via webhook (noms et avatars d'origine)</li>
        <li>Réouvrir le ticket avec le statut <strong>Ouvert</strong></li>
      </ul>

      <div class="flex items-start gap-2 p-3 rounded-lg bg-purple-500/5 border border-purple-500/15 mb-4">
        <Papicon icon="info" size={14} class="text-purple-400 mt-0.5 shrink-0" />
        <div class="text-[10px] text-purple-300/80 leading-relaxed">
          <p class="font-semibold mb-1">Limites de restauration ({remaining}/{maxRestores} restantes)</p>
          <p>1re — instantanée · 2e — après 24h · 3e — après 7 jours · Ensuite bloqué</p>
        </div>
      </div>

      <div class="flex items-start gap-2 p-3 rounded-lg bg-amber-500/5 border border-amber-500/15 mb-6">
        <Papicon icon="alert-triangle" size={14} class="text-amber-500 mt-0.5 shrink-0" />
        <p class="text-[10px] text-amber-500/80 leading-relaxed">La restauration peut prendre quelques secondes selon le nombre de messages. Les pièces jointes d'origine ne seront pas restaurées.</p>
      </div>

      <div class="flex gap-4 mt-8 pt-6 border-t border-outline-variant/20">
        <button onclick={() => showRestoreModal = false} disabled={restoring} class="flex-1 py-4 rounded-xl font-bold bg-surface-container hover:bg-surface-container-high transition-colors disabled:opacity-50">Annuler</button>
        <button
          onclick={restoreTicket}
          disabled={restoring}
          class="flex-1 py-4 rounded-xl font-bold bg-purple-600 text-white active:scale-[0.98] transition-transform shadow-sm disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {#if restoring}
            <div class="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin"></div>
            Restauration...
          {:else}
            Confirmer la restauration
          {/if}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Member Case Modal -->
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

<style>
  .scrollbar-hide::-webkit-scrollbar { display: none; }
  .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }

  /* Satisfaction Tab Styles */
  .sat-grid { display: grid; grid-template-columns: 300px 1fr; gap: 1rem; }
  .sat-card { background: var(--color-surface, rgba(255,255,255,0.05)); border: 1px solid var(--color-border, rgba(255,255,255,0.1)); border-radius: 12px; padding: 1.25rem; }
  .sat-card-title { margin: 0 0 1rem; font-size: 0.95rem; color: var(--color-text-secondary, rgba(255,255,255,0.6)); }

  .sat-overview-card { text-align: center; }
  .sat-avg-rating { display: flex; align-items: baseline; justify-content: center; gap: 0.25rem; }
  .sat-avg-value { font-size: 3rem; font-weight: 700; }
  .sat-avg-max { font-size: 1rem; color: var(--color-text-muted, rgba(255,255,255,0.4)); }
  .sat-avg-label { color: var(--color-text-muted, rgba(255,255,255,0.4)); font-size: 0.875rem; margin: 0.5rem 0 1.5rem; }

  .sat-distribution { display: flex; flex-direction: column; gap: 0.5rem; }
  .sat-dist-row { display: grid; grid-template-columns: 40px 1fr 30px; align-items: center; gap: 0.5rem; }
  .sat-dist-label { font-size: 0.85rem; }
  .sat-dist-bar { height: 8px; background: var(--color-border, rgba(255,255,255,0.1)); border-radius: 4px; overflow: hidden; }
  .sat-dist-fill { height: 100%; background: var(--color-primary, #5865F2); border-radius: 4px; }
  .sat-dist-count { text-align: right; font-size: 0.8rem; color: var(--color-text-muted, rgba(255,255,255,0.4)); }

  .sat-staff-list { display: flex; flex-direction: column; gap: 0.5rem; }
  .sat-staff-row { display: flex; align-items: center; gap: 0.75rem; width: 100%; padding: 0.55rem; border-radius: 8px; text-align: left; }
  .sat-staff-rating { font-weight: 600; }
  .sat-staff-count { font-size: 0.8rem; color: var(--color-text-muted, rgba(255,255,255,0.4)); }

  .sat-recent-card { grid-column: 1 / -1; }
  .sat-recent-list { display: flex; flex-direction: column; gap: 0.25rem; }
  .sat-review-row { display: grid; grid-template-columns: 2rem minmax(180px, 260px) minmax(0, 1fr) auto; align-items: center; gap: 0.75rem; padding: 0.45rem 0; font-size: 0.85rem; }
  .sat-review-emoji { font-size: 1.1rem; }
  .sat-review-user { min-width: 0; }
  .sat-review-comment { color: var(--color-text-muted, rgba(255,255,255,0.4)); font-style: italic; flex: 1; }
  .sat-review-date { color: var(--color-text-muted, rgba(255,255,255,0.4)); font-size: 0.75rem; }

  .sat-clickable-person { border: 0; background: transparent; color: inherit; cursor: pointer; font: inherit; padding: 0; transition: background-color 160ms ease, color 160ms ease; }
  .sat-clickable-person:hover { background: var(--color-surface-container-high, rgba(255,255,255,0.08)); }
  .sat-clickable-person:focus-visible { outline: 2px solid var(--color-primary, #5865F2); outline-offset: 2px; }
  .sat-person-main,
  .sat-review-user { display: flex; align-items: center; gap: 0.65rem; }
  .sat-person-main { flex: 1; min-width: 0; }
  .sat-person-avatar { width: 2rem; height: 2rem; border-radius: 999px; object-fit: cover; flex: 0 0 auto; }
  .sat-avatar-fallback { display: inline-flex; align-items: center; justify-content: center; background: var(--color-primary, #5865F2); color: white; font-size: 0.68rem; font-weight: 800; }
  .sat-person-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.15; }
  .sat-person-name { color: var(--color-text, var(--color-on-surface, rgba(255,255,255,0.9))); font-size: 0.86rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sat-person-handle { color: var(--color-text-muted, rgba(255,255,255,0.4)); font-size: 0.7rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .sat-empty { color: var(--color-text-muted, rgba(255,255,255,0.4)); font-style: italic; }

  @media (max-width: 768px) {
    .sat-grid { grid-template-columns: 1fr; }
    .sat-review-row { grid-template-columns: 2rem minmax(0, 1fr) auto; }
    .sat-review-comment { grid-column: 2 / -1; }
  }
</style>
