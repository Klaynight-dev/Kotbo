// ─── Onboarding System (Notion-style) ───────────────────────────────────────
// Three layers:
//   1. Welcome modal   - shown once on first guild visit
//   2. Checklist        - floating panel tracking onboarding tasks
//   3. Page tips        - contextual cards on first page visit

import { m } from '../i18n';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChecklistTask {
  id: string;
  title: string;
  description: string;
  icon: string;
  /** Route to navigate when clicking the task */
  route?: string;
  /** Auto-complete when user visits this route */
  autoCompleteRoute?: string;
}

export interface SetupTask {
  id: string;
  title: string;
  description: string;
  icon: string;
  route: string;
  autoCompleteRoute: string;
  /** true = must-do first, false = optional / à la carte */
  essential: boolean;
}

export type GuideTab = 'discover' | 'setup';

export interface PageTip {
  pageId: string;
  /** Route pattern (exact or startsWith) */
  routes: string[];
  title: string;
  description: string;
  highlights: string[];
  icon: string;
}

export interface OnboardingState {
  welcomeSeen: boolean;
  checklistDismissed: boolean;
  checklistMinimized: boolean;
  completedTasks: string[];
  completedSetupTasks: string[];
  activeTab: GuideTab;
  visitedPages: string[];
  startedAt: number;
  completedAt?: number;
}

// ─── Checklist Tasks ────────────────────────────────────────────────────────

export const checklistTasks: ChecklistTask[] = [
  {
    id: 'visit-overview',
    title: m.chk_visit_overview_title(),
    description: m.chk_visit_overview_desc(),
    icon: 'layout-grid',
    route: '/',
    autoCompleteRoute: '/',
  },
  {
    id: 'explore-modules',
    title: m.chk_explore_modules_title(),
    description: m.chk_explore_modules_desc(),
    icon: 'package',
    route: '/modules',
    autoCompleteRoute: '/modules',
  },
  {
    id: 'check-members',
    title: m.chk_check_members_title(),
    description: m.chk_check_members_desc(),
    icon: 'users',
    route: '/members',
    autoCompleteRoute: '/members',
  },
  {
    id: 'review-moderation',
    title: m.chk_review_moderation_title(),
    description: m.chk_review_moderation_desc(),
    icon: 'shield',
    route: '/security/sanctions',
    autoCompleteRoute: '/security/sanctions',
  },
  {
    id: 'setup-community',
    title: m.chk_setup_community_title(),
    description: m.chk_setup_community_desc(),
    icon: 'trophy',
    route: '/leveling',
    autoCompleteRoute: '/leveling',
  },
  {
    id: 'manage-staff',
    title: m.chk_manage_staff_title(),
    description: m.chk_manage_staff_desc(),
    icon: 'user-check',
    route: '/staff-management?tab=members',
    autoCompleteRoute: '/staff-management',
  },
  {
    id: 'configure-settings',
    title: m.chk_configure_settings_title(),
    description: m.chk_configure_settings_desc(),
    icon: 'settings',
    route: '/management',
    autoCompleteRoute: '/management',
  },
  {
    id: 'try-shortcuts',
    title: m.chk_try_shortcuts_title(),
    description: m.chk_try_shortcuts_desc(),
    icon: 'keyboard',
  },
];

// ─── Setup Guide Tasks (2nd tutorial) ───────────────────────────────────────
// Essential tasks first, then optional features

export const setupTasks: SetupTask[] = [
  // ── Essentiels (à faire en premier) ──
  {
    id: 'setup-regulation',
    title: m.stp_setup_regulation_title(),
    description: m.stp_setup_regulation_desc(),
    icon: 'book',
    route: '/regulation',
    autoCompleteRoute: '/regulation',
    essential: true,
  },
  {
    id: 'setup-hierarchy',
    title: m.stp_setup_hierarchy_title(),
    description: m.stp_setup_hierarchy_desc(),
    icon: 'shield',
    route: '/staff-management?tab=roles',
    autoCompleteRoute: '/staff-management',
    essential: true,
  },
  {
    id: 'setup-channels',
    title: m.stp_setup_channels_title(),
    description: m.stp_setup_channels_desc(),
    icon: 'hash',
    route: '/channels-management',
    autoCompleteRoute: '/channels-management',
    essential: true,
  },
  {
    id: 'setup-staff-members',
    title: m.stp_setup_staff_members_title(),
    description: m.stp_setup_staff_members_desc(),
    icon: 'user-check',
    route: '/staff-management?tab=members',
    autoCompleteRoute: '/staff-management',
    essential: true,
  },

  // ── Optionnels (personnalisation) ──
  {
    id: 'setup-automod',
    title: m.stp_setup_automod_title(),
    description: m.stp_setup_automod_desc(),
    icon: 'shield-alert',
    route: '/security/filters',
    autoCompleteRoute: '/security/filters',
    essential: false,
  },
  {
    id: 'setup-welcome',
    title: m.stp_setup_welcome_title(),
    description: m.stp_setup_welcome_desc(),
    icon: 'megaphone',
    route: '/announcement',
    autoCompleteRoute: '/announcement',
    essential: false,
  },
  {
    id: 'setup-leveling',
    title: m.stp_setup_leveling_title(),
    description: m.stp_setup_leveling_desc(),
    icon: 'trophy',
    route: '/leveling',
    autoCompleteRoute: '/leveling',
    essential: false,
  },
  {
    id: 'setup-economy',
    title: m.stp_setup_economy_title(),
    description: m.stp_setup_economy_desc(),
    icon: 'coins',
    route: '/economy',
    autoCompleteRoute: '/economy',
    essential: false,
  },
  {
    id: 'setup-tickets',
    title: m.stp_setup_tickets_title(),
    description: m.stp_setup_tickets_desc(),
    icon: 'message-square',
    route: '/tickets',
    autoCompleteRoute: '/tickets',
    essential: false,
  },
  {
    id: 'setup-reaction-roles',
    title: m.stp_setup_reaction_roles_title(),
    description: m.stp_setup_reaction_roles_desc(),
    icon: 'mouse-pointer',
    route: '/reaction-roles',
    autoCompleteRoute: '/reaction-roles',
    essential: false,
  },
  {
    id: 'setup-suggestions',
    title: m.stp_setup_suggestions_title(),
    description: m.stp_setup_suggestions_desc(),
    icon: 'thumbs-up',
    route: '/suggestions',
    autoCompleteRoute: '/suggestions',
    essential: false,
  },
  {
    id: 'setup-giveaways',
    title: m.stp_setup_giveaways_title(),
    description: m.stp_setup_giveaways_desc(),
    icon: 'sparkles',
    route: '/giveaways',
    autoCompleteRoute: '/giveaways',
    essential: false,
  },
  {
    id: 'setup-triggers',
    title: m.stp_setup_triggers_title(),
    description: m.stp_setup_triggers_desc(),
    icon: 'message-square',
    route: '/triggers',
    autoCompleteRoute: '/triggers',
    essential: false,
  },
  {
    id: 'setup-embeds',
    title: m.stp_setup_embeds_title(),
    description: m.stp_setup_embeds_desc(),
    icon: 'file-plus',
    route: '/embed-builder',
    autoCompleteRoute: '/embed-builder',
    essential: false,
  },
  {
    id: 'setup-logs',
    title: m.stp_setup_logs_title(),
    description: m.stp_setup_logs_desc(),
    icon: 'file-text',
    route: '/logs',
    autoCompleteRoute: '/logs',
    essential: false,
  },
  {
    id: 'setup-recruitment',
    title: m.stp_setup_recruitment_title(),
    description: m.stp_setup_recruitment_desc(),
    icon: 'user-plus',
    route: '/recruitment',
    autoCompleteRoute: '/recruitment',
    essential: false,
  },
  {
    id: 'setup-news',
    title: m.stp_setup_news_title(),
    description: m.stp_setup_news_desc(),
    icon: 'rss',
    route: '/news',
    autoCompleteRoute: '/news',
    essential: false,
  },
  {
    id: 'setup-fun',
    title: m.stp_setup_fun_title(),
    description: m.stp_setup_fun_desc(),
    icon: 'smile',
    route: '/fun',
    autoCompleteRoute: '/fun',
    essential: false,
  },
  {
    id: 'setup-social',
    title: m.stp_setup_social_title(),
    description: m.stp_setup_social_desc(),
    icon: 'share-2',
    route: '/social-networks',
    autoCompleteRoute: '/social-networks',
    essential: false,
  },
  {
    id: 'setup-schedules',
    title: m.stp_setup_schedules_title(),
    description: m.stp_setup_schedules_desc(),
    icon: 'calendar',
    route: '/schedules',
    autoCompleteRoute: '/schedules',
    essential: false,
  },
  {
    id: 'setup-backups',
    title: m.stp_setup_backups_title(),
    description: m.stp_setup_backups_desc(),
    icon: 'archive',
    route: '/backups',
    autoCompleteRoute: '/backups',
    essential: false,
  },
];

export const essentialSetupTasks = setupTasks.filter(t => t.essential);
export const optionalSetupTasks = setupTasks.filter(t => !t.essential);

// ─── Page Tips ──────────────────────────────────────────────────────────────

export const pageTips: PageTip[] = [
  {
    pageId: 'overview',
    routes: ['/'],
    title: m.tip_overview_title(),
    description: m.tip_overview_desc(),
    highlights: [
      m.tip_overview_h1(),
      m.tip_overview_h2(),
      m.tip_overview_h3(),
    ],
    icon: 'layout-grid',
  },
  {
    pageId: 'inbox',
    routes: ['/inbox'],
    title: m.tip_inbox_title(),
    description: m.tip_inbox_desc(),
    highlights: [
      m.tip_inbox_h1(),
      m.tip_inbox_h2(),
      m.tip_inbox_h3(),
    ],
    icon: 'inbox',
  },
  {
    pageId: 'analytics',
    routes: ['/analytics'],
    title: m.tip_analytics_title(),
    description: m.tip_analytics_desc(),
    highlights: [
      m.tip_analytics_h1(),
      m.tip_analytics_h2(),
      m.tip_analytics_h3(),
    ],
    icon: 'pie-chart',
  },
  {
    pageId: 'members',
    routes: ['/members'],
    title: m.tip_members_title(),
    description: m.tip_members_desc(),
    highlights: [
      m.tip_members_h1(),
      m.tip_members_h2(),
      m.tip_members_h3(),
    ],
    icon: 'users',
  },
  {
    pageId: 'sanctions',
    routes: ['/security/sanctions'],
    title: m.tip_sanctions_title(),
    description: m.tip_sanctions_desc(),
    highlights: [
      m.tip_sanctions_h1(),
      m.tip_sanctions_h2(),
      m.tip_sanctions_h3(),
    ],
    icon: 'alert-triangle',
  },
  {
    pageId: 'automod',
    routes: ['/security/filters'],
    title: m.tip_automod_title(),
    description: m.tip_automod_desc(),
    highlights: [
      m.tip_automod_h1(),
      m.tip_automod_h2(),
      m.tip_automod_h3(),
    ],
    icon: 'shield-alert',
  },
  {
    pageId: 'logs',
    routes: ['/logs'],
    title: m.tip_logs_title(),
    description: m.tip_logs_desc(),
    highlights: [
      m.tip_logs_h1(),
      m.tip_logs_h2(),
      m.tip_logs_h3(),
    ],
    icon: 'file-text',
  },
  {
    pageId: 'activity',
    routes: ['/activity'],
    title: m.tip_activity_title(),
    description: m.tip_activity_desc(),
    highlights: [
      m.tip_activity_h1(),
      m.tip_activity_h2(),
      m.tip_activity_h3(),
    ],
    icon: 'history',
  },
  {
    pageId: 'invitations',
    routes: ['/invitations'],
    title: m.tip_invitations_title(),
    description: m.tip_invitations_desc(),
    highlights: [
      m.tip_invitations_h1(),
      m.tip_invitations_h2(),
      m.tip_invitations_h3(),
    ],
    icon: 'link',
  },
  {
    pageId: 'events',
    routes: ['/events'],
    title: m.tip_events_title(),
    description: m.tip_events_desc(),
    highlights: [
      m.tip_events_h1(),
      m.tip_events_h2(),
      m.tip_events_h3(),
    ],
    icon: 'zap',
  },
  {
    pageId: 'leveling',
    routes: ['/leveling'],
    title: m.tip_leveling_title(),
    description: m.tip_leveling_desc(),
    highlights: [
      m.tip_leveling_h1(),
      m.tip_leveling_h2(),
      m.tip_leveling_h3(),
    ],
    icon: 'trophy',
  },
  {
    pageId: 'economy',
    routes: ['/economy'],
    title: m.tip_economy_title(),
    description: m.tip_economy_desc(),
    highlights: [
      m.tip_economy_h1(),
      m.tip_economy_h2(),
      m.tip_economy_h3(),
    ],
    icon: 'coins',
  },
  {
    pageId: 'giveaways',
    routes: ['/giveaways'],
    title: m.tip_giveaways_title(),
    description: m.tip_giveaways_desc(),
    highlights: [
      m.tip_giveaways_h1(),
      m.tip_giveaways_h2(),
      m.tip_giveaways_h3(),
    ],
    icon: 'sparkles',
  },
  {
    pageId: 'announcement',
    routes: ['/welcome', '/announcement'],
    title: m.tip_announcement_title(),
    description: m.tip_announcement_desc(),
    highlights: [
      m.tip_announcement_h1(),
      m.tip_announcement_h2(),
      m.tip_announcement_h3(),
    ],
    icon: 'megaphone',
  },
  {
    pageId: 'reaction-roles',
    routes: ['/reaction-roles'],
    title: m.tip_reaction_roles_title(),
    description: m.tip_reaction_roles_desc(),
    highlights: [
      m.tip_reaction_roles_h1(),
      m.tip_reaction_roles_h2(),
      m.tip_reaction_roles_h3(),
    ],
    icon: 'mouse-pointer',
  },
  {
    pageId: 'triggers',
    routes: ['/triggers'],
    title: m.tip_triggers_title(),
    description: m.tip_triggers_desc(),
    highlights: [
      m.tip_triggers_h1(),
      m.tip_triggers_h2(),
      m.tip_triggers_h3(),
    ],
    icon: 'message-square',
  },
  {
    pageId: 'suggestions',
    routes: ['/suggestions'],
    title: m.tip_suggestions_title(),
    description: m.tip_suggestions_desc(),
    highlights: [
      m.tip_suggestions_h1(),
      m.tip_suggestions_h2(),
      m.tip_suggestions_h3(),
    ],
    icon: 'thumbs-up',
  },
  {
    pageId: 'embed-builder',
    routes: ['/embed-builder'],
    title: m.tip_embed_builder_title(),
    description: m.tip_embed_builder_desc(),
    highlights: [
      m.tip_embed_builder_h1(),
      m.tip_embed_builder_h2(),
      m.tip_embed_builder_h3(),
    ],
    icon: 'file-plus',
  },
  {
    pageId: 'regulation',
    routes: ['/regulation'],
    title: m.tip_regulation_title(),
    description: m.tip_regulation_desc(),
    highlights: [
      m.tip_regulation_h1(),
      m.tip_regulation_h2(),
      m.tip_regulation_h3(),
    ],
    icon: 'book',
  },
  {
    pageId: 'news',
    routes: ['/news'],
    title: m.tip_news_title(),
    description: m.tip_news_desc(),
    highlights: [
      m.tip_news_h1(),
      m.tip_news_h2(),
      m.tip_news_h3(),
    ],
    icon: 'rss',
  },
  {
    pageId: 'staff-management',
    routes: ['/staff-management'],
    title: m.tip_staff_management_title(),
    description: m.tip_staff_management_desc(),
    highlights: [
      m.tip_staff_management_h1(),
      m.tip_staff_management_h2(),
      m.tip_staff_management_h3(),
    ],
    icon: 'user-check',
  },
  {
    pageId: 'recruitment',
    routes: ['/recruitment'],
    title: m.tip_recruitment_title(),
    description: m.tip_recruitment_desc(),
    highlights: [
      m.tip_recruitment_h1(),
      m.tip_recruitment_h2(),
      m.tip_recruitment_h3(),
    ],
    icon: 'user-plus',
  },
  {
    pageId: 'tickets',
    routes: ['/tickets'],
    title: m.tip_tickets_title(),
    description: m.tip_tickets_desc(),
    highlights: [
      m.tip_tickets_h1(),
      m.tip_tickets_h2(),
      m.tip_tickets_h3(),
    ],
    icon: 'message-square',
  },
  {
    pageId: 'tutoring',
    routes: ['/tutoring'],
    title: m.tip_tutoring_title(),
    description: m.tip_tutoring_desc(),
    highlights: [
      m.tip_tutoring_h1(),
      m.tip_tutoring_h2(),
      m.tip_tutoring_h3(),
    ],
    icon: 'book-open',
  },
  {
    pageId: 'planning',
    routes: ['/planning'],
    title: m.tip_planning_title(),
    description: m.tip_planning_desc(),
    highlights: [
      m.tip_planning_h1(),
      m.tip_planning_h2(),
      m.tip_planning_h3(),
    ],
    icon: 'calendar',
  },
  {
    pageId: 'modules',
    routes: ['/modules'],
    title: m.tip_modules_title(),
    description: m.tip_modules_desc(),
    highlights: [
      m.tip_modules_h1(),
      m.tip_modules_h2(),
      m.tip_modules_h3(),
    ],
    icon: 'package',
  },
  {
    pageId: 'channels-management',
    routes: ['/channels-management'],
    title: m.tip_channels_management_title(),
    description: m.tip_channels_management_desc(),
    highlights: [
      m.tip_channels_management_h1(),
      m.tip_channels_management_h2(),
      m.tip_channels_management_h3(),
    ],
    icon: 'hash',
  },
  {
    pageId: 'command-access',
    routes: ['/command-access'],
    title: m.tip_command_access_title(),
    description: m.tip_command_access_desc(),
    highlights: [
      m.tip_command_access_h1(),
      m.tip_command_access_h2(),
      m.tip_command_access_h3(),
    ],
    icon: 'terminal',
  },
  {
    pageId: 'nickname-moderation',
    routes: ['/security/filters/nicknames'],
    title: m.tip_nickname_moderation_title(),
    description: m.tip_nickname_moderation_desc(),
    highlights: [
      m.tip_nickname_moderation_h1(),
      m.tip_nickname_moderation_h2(),
      m.tip_nickname_moderation_h3(),
    ],
    icon: 'filter',
  },
  {
    pageId: 'double-accounts',
    routes: ['/security/accounts'],
    title: m.tip_double_accounts_title(),
    description: m.tip_double_accounts_desc(),
    highlights: [
      m.tip_double_accounts_h1(),
      m.tip_double_accounts_h2(),
      m.tip_double_accounts_h3(),
    ],
    icon: 'shield',
  },
  {
    pageId: 'forms',
    routes: ['/forms'],
    title: m.tip_forms_title(),
    description: m.tip_forms_desc(),
    highlights: [
      m.tip_forms_h1(),
      m.tip_forms_h2(),
      m.tip_forms_h3(),
    ],
    icon: 'clipboard',
  },
  {
    pageId: 'fun',
    routes: ['/fun'],
    title: m.tip_fun_title(),
    description: m.tip_fun_desc(),
    highlights: [
      m.tip_fun_h1(),
      m.tip_fun_h2(),
      m.tip_fun_h3(),
    ],
    icon: 'smile',
  },
  {
    pageId: 'social-networks',
    routes: ['/social-networks'],
    title: m.tip_social_networks_title(),
    description: m.tip_social_networks_desc(),
    highlights: [
      m.tip_social_networks_h1(),
      m.tip_social_networks_h2(),
      m.tip_social_networks_h3(),
    ],
    icon: 'share-2',
  },
  {
    pageId: 'backups',
    routes: ['/backups'],
    title: m.tip_backups_title(),
    description: m.tip_backups_desc(),
    highlights: [
      m.tip_backups_h1(),
      m.tip_backups_h2(),
      m.tip_backups_h3(),
    ],
    icon: 'archive',
  },
  {
    pageId: 'schedules',
    routes: ['/schedules'],
    title: m.tip_schedules_title(),
    description: m.tip_schedules_desc(),
    highlights: [
      m.tip_schedules_h1(),
      m.tip_schedules_h2(),
      m.tip_schedules_h3(),
    ],
    icon: 'calendar',
  },
];

// ─── Defaults & Storage ─────────────────────────────────────────────────────

const DEFAULT_STATE: OnboardingState = {
  welcomeSeen: false,
  checklistDismissed: false,
  checklistMinimized: true,
  completedTasks: [],
  completedSetupTasks: [],
  activeTab: 'discover',
  visitedPages: [],
  startedAt: 0,
};

const STORAGE_PREFIX = 'onboarding-';
const LEGACY_KEY = 'tutorial-progress';

const getStorageKey = (guildId: string) => `${STORAGE_PREFIX}${guildId}`;

function readState(guildId: string): OnboardingState {
  try {
    const raw = localStorage.getItem(getStorageKey(guildId));
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_STATE, ...parsed };
    }

    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy);
      if (parsed?.completed || parsed?.dismissed || parsed?.seen) {
        return {
          ...DEFAULT_STATE,
          welcomeSeen: true,
          checklistDismissed: true,
          completedTasks: checklistTasks.map(t => t.id),
          completedSetupTasks: setupTasks.map(t => t.id),
          visitedPages: pageTips.map(p => p.pageId),
          startedAt: parsed.startedAt ?? Date.now(),
          completedAt: parsed.completedAt ?? Date.now(),
        };
      }
    }

    const legacyGuild = localStorage.getItem(`tutorial-${guildId}`);
    if (legacyGuild) {
      const parsed = JSON.parse(legacyGuild);
      if (parsed?.completed || parsed?.dismissed || parsed?.seen) {
        return {
          ...DEFAULT_STATE,
          welcomeSeen: true,
          checklistDismissed: true,
          completedTasks: checklistTasks.map(t => t.id),
          completedSetupTasks: setupTasks.map(t => t.id),
          visitedPages: pageTips.map(p => p.pageId),
          startedAt: parsed.startedAt ?? Date.now(),
          completedAt: parsed.completedAt ?? Date.now(),
        };
      }
    }
  } catch {
    // ignore
  }
  return { ...DEFAULT_STATE };
}

function writeState(guildId: string | null, state: OnboardingState) {
  if (!guildId) return;
  try {
    localStorage.setItem(getStorageKey(guildId), JSON.stringify(state));
  } catch {
    // ignore
  }
}

// ─── Reactive State ─────────────────────────────────────────────────────────

let guildId = $state<string | null>(null);
let state = $state<OnboardingState>({ ...DEFAULT_STATE });

// Welcome modal visibility
let showWelcome = $state(false);

// Active page tip
let activePageTip = $state<PageTip | null>(null);
let pageTipDismissed = $state(false);

// ─── Store ──────────────────────────────────────────────────────────────────

export const onboardingStore = {
  // ── Getters - Discover tab ──
  get initialized() { return guildId !== null; },
  get welcomeSeen() { return state.welcomeSeen; },
  get showWelcome() { return showWelcome; },
  get checklistDismissed() { return state.checklistDismissed; },
  get checklistMinimized() { return state.checklistMinimized; },
  get completedTasks() { return state.completedTasks; },
  get visitedPages() { return state.visitedPages; },
  get activePageTip() { return activePageTip; },
  get pageTipDismissed() { return pageTipDismissed; },
  get activeTab() { return state.activeTab; },

  get completedCount() {
    return state.completedTasks.length;
  },

  get totalTasks() {
    return checklistTasks.length;
  },

  get progress() {
    return checklistTasks.length === 0 ? 100 : Math.round((state.completedTasks.length / checklistTasks.length) * 100);
  },

  get allCompleted() {
    return state.completedTasks.length >= checklistTasks.length;
  },

  // ── Getters - Setup tab ──
  get completedSetupTasks() { return state.completedSetupTasks; },

  get completedSetupCount() {
    return state.completedSetupTasks.length;
  },

  get totalSetupTasks() {
    return setupTasks.length;
  },

  get essentialSetupCount() {
    return essentialSetupTasks.length;
  },

  get completedEssentialCount() {
    return essentialSetupTasks.filter(t => state.completedSetupTasks.includes(t.id)).length;
  },

  get setupProgress() {
    return setupTasks.length === 0 ? 100 : Math.round((state.completedSetupTasks.length / setupTasks.length) * 100);
  },

  get essentialsDone() {
    return essentialSetupTasks.every(t => state.completedSetupTasks.includes(t.id));
  },

  get allSetupCompleted() {
    return state.completedSetupTasks.length >= setupTasks.length;
  },

  // ── Getters - Combined ──
  get overallProgress() {
    const total = checklistTasks.length + setupTasks.length;
    const done = state.completedTasks.length + state.completedSetupTasks.length;
    return total === 0 ? 100 : Math.round((done / total) * 100);
  },

  get bothCompleted() {
    return this.allCompleted && this.allSetupCompleted;
  },

  isTaskCompleted(taskId: string): boolean {
    return state.completedTasks.includes(taskId);
  },

  isSetupTaskCompleted(taskId: string): boolean {
    return state.completedSetupTasks.includes(taskId);
  },

  isPageVisited(pageId: string): boolean {
    return state.visitedPages.includes(pageId);
  },

  // ── Actions ──

  initialize(newGuildId: string) {
    if (guildId === newGuildId) return;
    guildId = newGuildId;
    state = readState(newGuildId);

    if (!state.welcomeSeen && !state.startedAt) {
      showWelcome = true;
      state.startedAt = Date.now();
      writeState(guildId, state);
    }
  },

  // Welcome
  dismissWelcome() {
    showWelcome = false;
    state.welcomeSeen = true;
    state.checklistMinimized = false;
    writeState(guildId, state);
  },

  // Checklist
  toggleChecklist() {
    state.checklistMinimized = !state.checklistMinimized;
    writeState(guildId, state);
  },

  expandChecklist() {
    state.checklistMinimized = false;
    writeState(guildId, state);
  },

  minimizeChecklist() {
    state.checklistMinimized = true;
    writeState(guildId, state);
  },

  dismissChecklist() {
    state.checklistDismissed = true;
    writeState(guildId, state);
  },

  setActiveTab(tab: GuideTab) {
    state.activeTab = tab;
    writeState(guildId, state);
  },

  completeTask(taskId: string) {
    if (state.completedTasks.includes(taskId)) return;
    state.completedTasks = [...state.completedTasks, taskId];

    if (state.completedTasks.length >= checklistTasks.length) {
      state.completedAt = Date.now();
    }

    writeState(guildId, state);
  },

  completeSetupTask(taskId: string) {
    if (state.completedSetupTasks.includes(taskId)) return;
    state.completedSetupTasks = [...state.completedSetupTasks, taskId];
    writeState(guildId, state);
  },

  // Page tips
  onPageVisit(path: string, queryString: string = '') {
    const fullUrl = path + (queryString ? `?${queryString}` : '');

    // Auto-complete discover checklist tasks
    for (const task of checklistTasks) {
      if (!task.autoCompleteRoute) continue;
      if (path === task.autoCompleteRoute || path.startsWith(task.autoCompleteRoute + '/')) {
        this.completeTask(task.id);
      }
    }

    // Auto-complete setup tasks
    for (const task of setupTasks) {
      if (path === task.autoCompleteRoute || path.startsWith(task.autoCompleteRoute + '/')) {
        this.completeSetupTask(task.id);
      }
    }

    // Find matching page tip
    const tip = pageTips.find(p =>
      p.routes.some(r => {
        if (r === '/') return path === '/';
        return path === r || path.startsWith(r + '/') || fullUrl.includes(r);
      })
    );

    if (tip && !state.visitedPages.includes(tip.pageId)) {
      activePageTip = tip;
      pageTipDismissed = false;
    } else {
      activePageTip = null;
      pageTipDismissed = false;
    }
  },

  dismissPageTip() {
    if (activePageTip) {
      state.visitedPages = [...state.visitedPages, activePageTip.pageId];
      writeState(guildId, state);
    }
    pageTipDismissed = true;
    activePageTip = null;
  },

  // Complete reset
  reset() {
    state = {
      ...DEFAULT_STATE,
      startedAt: Date.now(),
    };
    showWelcome = true;
    activePageTip = null;
    pageTipDismissed = false;
    writeState(guildId, state);
  },

  // Restart tutorial (from menu)
  restart() {
    state = {
      ...DEFAULT_STATE,
      welcomeSeen: false,
      startedAt: Date.now(),
    };
    showWelcome = true;
    activePageTip = null;
    pageTipDismissed = false;
    writeState(guildId, state);
  },

  // Mark shortcut task as done (called from keyboard handler)
  markShortcutUsed() {
    this.completeTask('try-shortcuts');
  },
};

// Legacy exports for backward compat with MainLayout/Navbar references
export const tutorialStore = onboardingStore;
export const tutorialSteps = checklistTasks;
export function shouldShowTutorialForNewUser(guildId: string): boolean {
  const s = readState(guildId);
  return !s.welcomeSeen && !s.startedAt;
}
