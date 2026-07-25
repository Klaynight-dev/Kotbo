import { fetchGuildState, API_BASE_URL, fetchApprenticeProgress } from '../api';
import { authStore } from './auth.svelte';

class DashboardStore {
  private retryTimer: any = null;
  private retryCount = 0;

  state = $state({
    guildName: 'Kotbo',
    configChannelId: '',
    logChannelId: '',
    regulationChannelId: '',
    regulationMessageId: null,
    regulationVerificationEnabled: false,
    regulationRoleId: '',
    regulationLockEnabled: false,
    meetingAnnouncementChannelId: '',
    meetingVoiceChannelId: '',
    publicChannelId: '',
    dailyAlgoChannelId: '',
    baseStaffRoleId: '',
    testStaffRoleId: '',
    discordChannels: [] as any[],
    discordVoiceChannels: [] as any[],
    discordCategories: [] as any[],
    discordRoles: [] as any[],
    moderatorRoleId: '',
    propagateSanctions: false,
    crossServerSanctionsEnabled: true,
    sanctionReportEnabled: true,
    translationEnabled: false,
    codePoliceEnabled: false,
    dailyAlgoEnabled: false,
    // ── Daily Algo v2 : barème, semaine, sanctions, pont clans ──
    dailyAlgoTimezone: 'Europe/Paris',
    dailyAlgoParticipationPoints: 1,
    dailyAlgoWeekendMultiplier: 1.5,
    dailyAlgoWeeklyRewardsEnabled: false,
    dailyAlgoWeekRole1Id: '',
    dailyAlgoWeekRole2Id: '',
    dailyAlgoWeekRole3Id: '',
    dailyAlgoWeekRoleRotate: true,
    dailyAlgoWeekXp1: 500,
    dailyAlgoWeekXp2: 300,
    dailyAlgoWeekXp3: 150,
    dailyAlgoWeekParticipationXp: 100,
    dailyAlgoWeekAnnouncementChannelId: '',
    dailyAlgoSanctionType: 'WARN',
    dailyAlgoSanctionWeight: 1,
    dailyAlgoSanctionDurationMinutes: 60,
    clanPointsFromDailyAlgo: false,
    clanPointsFromDailyAlgoRate: 1,
    clanPointsDailyAlgoTop1: 30,
    clanPointsDailyAlgoTop2: 20,
    clanPointsDailyAlgoTop3: 10,
    githubReleasesEnabled: false,
    digestEnabled: false,
    youtubeEnabled: false,
    autoThreadEnabled: false,
    autoThreadChannels: [] as string[],
    funEnabled: false,
    economyEnabled: false,
    levelingEnabled: false,
    isStaffServer: false,
    funCountingChannelId: '',
    funOneWordStoryChannelId: '',
    funGuessNumberChannelId: '',
    commandRestrictions: [] as any[],
    sidebarFavorites: [] as string[],
    commandCatalog: [] as any[],
    access: {
      level: 'moderator',
      canModerateContent: false,
      canModerateDailyAlgo: false,
      canManageSettings: false
    },
    featureAccess: {} as Record<string, { canView?: boolean; canConfigure?: boolean }>,
    modules: [],
    notifications: {
      discordChannel: '#alertes-redaction',
      email: '',
      emailEnabled: false,
      cloudBackup: true,
      debugLog: false,
      killSwitchEnabled: false,
      severityByModule: []
    },
    auditTrail: [] as any[],
    sanctions: [] as any[],
    sanctionReports: [] as any[],
    sanctionTables: [] as any[],
    statusCheckChannelId: '',
    regulationRules: [] as any[],
    messageTemplate: '',
    analytics: {
      activityTrend: [0, 0, 0, 0, 0, 0, 0],
      messagesTrend: [0, 0, 0, 0, 0, 0, 0],
      voiceTrend: [0, 0, 0, 0, 0, 0, 0],
      joinsTrend: [0, 0, 0, 0, 0, 0, 0],
      leavesTrend: [0, 0, 0, 0, 0, 0, 0],
      sanctionsTrend: [0, 0, 0, 0, 0, 0, 0],
      totalAutomations: 0,
      healthStatus: 100
    },
    apprenticeProgress: null,
    isTutor: false,
    loading: true,
    error: null
  });

  /**
   * Rafraichissement en cours, partage entre tous les appelants concurrents.
   *
   * `refresh()` rendait la main immediatement quand un autre rafraichissement
   * etait deja en vol : un `await dashboardStore.refresh()` pouvait donc se
   * terminer sans qu'aucune donnee ait ete relue. Un appelant qui enchaine sur
   * une relecture du store (formulaire d'options resynchronise apres un
   * enregistrement) reaffichait alors les anciennes valeurs, et l'utilisateur
   * voyait ses reglages "revenir en arriere" alors qu'ils etaient bien ecrits
   * en base. On rend desormais la promesse en cours, pour que l'attente
   * signifie toujours "les donnees sont a jour".
   */
  private refreshPromise: Promise<void> | null = null;
  /**
   * Guild pour laquelle un `refresh()` a deja abouti. Sert a distinguer le
   * premier chargement (qui doit afficher un etat d'attente) des
   * rafraichissements en arriere-plan. Compare a la guild courante plutot que
   * pilote depuis `authStore`, pour eviter un import circulaire entre les deux
   * stores.
   */
  private loadedGuildId: string | null = null;

  private mergeAuditTrail(existing: any[], incoming: any[]): any[] {
    if (!Array.isArray(incoming) || incoming.length === 0) {
      return existing;
    }
    
    const allEntries = new Map();
    
    // Add existing
    for (const e of existing) {
      const key = e.id || `${e.dateIso}-${e.user}-${e.action}-${e.module}`;
      allEntries.set(key, e);
    }
    
    // Add incoming (deduplicates within incoming too if they lack IDs)
    for (const e of incoming) {
      const key = e.id || `${e.dateIso}-${e.user}-${e.action}-${e.module}`;
      allEntries.set(key, e);
    }
    
    // Convert back and sort by date descending
    return Array.from(allEntries.values())
      .sort((a, b) => new Date(b.dateIso).getTime() - new Date(a.dateIso).getTime())
      .slice(0, 1000); // Keep reasonable history
  }

  async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    if (!authStore.token || !authStore.selectedGuildId) {
      this.state.loading = false;
      return;
    }

    const pending = this.runRefresh();
    this.refreshPromise = pending;
    try {
      await pending;
    } finally {
      // Ne libere le verrou que s'il s'agit toujours du notre : un appel parti
      // entre-temps garde la main sur le sien.
      if (this.refreshPromise === pending) this.refreshPromise = null;
    }
  }

  private async runRefresh(): Promise<void> {
    // Fige la guild visee pour toute la duree de l'appel : si l'utilisateur
    // change de serveur pendant la requete, on ne doit pas marquer la nouvelle
    // guild comme chargee avec les donnees de l'ancienne.
    const requestedGuildId = authStore.selectedGuildId;

    // `loading` ne vaut `true` que tant qu'aucune donnee n'est affichable.
    // Les rafraichissements suivants (message WebSocket, cycle de 10 min,
    // bouton "actualiser") se font en arriere-plan : remettre `loading` a true
    // renvoyait toute l'interface sur ses ecrans de chargement alors que les
    // donnees precedentes etaient deja a l'ecran et parfaitement valides.
    // Un changement de serveur repart d'un premier chargement : les donnees
    // affichees appartiennent a l'ancienne guild et ne doivent pas etre prises
    // pour des donnees a jour.
    if (this.loadedGuildId !== requestedGuildId) {
      this.state.loading = true;
    }

    try {
      const [data, apprenticeData] = await Promise.all([
        fetchGuildState(),
        fetchApprenticeProgress().catch(() => ({ progress: null }))
      ]);
      
      if (data) {
        this.state.guildName = data.guildName;
        this.state.configChannelId = data.configChannelId || '';
        this.state.logChannelId = data.logChannelId || '';
        this.state.regulationChannelId = data.regulationChannelId || '';
        this.state.regulationMessageId = data.regulationMessageId || null;
        this.state.regulationVerificationEnabled = data.regulationVerificationEnabled || false;
        this.state.regulationRoleId = data.regulationRoleId || '';
        this.state.regulationLockEnabled = data.regulationLockEnabled || false;
        this.state.meetingAnnouncementChannelId = data.meetingAnnouncementChannelId || '';
        this.state.meetingVoiceChannelId = data.meetingVoiceChannelId || '';
        this.state.publicChannelId = data.publicChannelId || '';
        this.state.dailyAlgoChannelId = data.dailyAlgoChannelId || '';
        this.state.baseStaffRoleId = data.baseStaffRoleId || '';
        this.state.testStaffRoleId = data.testStaffRoleId || '';
        this.state.discordChannels = data.discordChannels || [];
        this.state.discordVoiceChannels = data.discordVoiceChannels || [];
        this.state.discordCategories = data.discordCategories || [];
        this.state.discordRoles = data.discordRoles || [];
        this.state.moderatorRoleId = data.moderatorRoleId || '';
        this.state.propagateSanctions = data.propagateSanctions || false;
        this.state.crossServerSanctionsEnabled = data.crossServerSanctionsEnabled ?? true;
        this.state.sanctionReportEnabled = data.sanctionReportEnabled ?? true;
        this.state.translationEnabled = data.translationEnabled || false;
        this.state.codePoliceEnabled = data.codePoliceEnabled || false;
        this.state.dailyAlgoEnabled = data.dailyAlgoEnabled || false;
        this.state.dailyAlgoTimezone = data.dailyAlgoTimezone || 'Europe/Paris';
        this.state.dailyAlgoParticipationPoints = data.dailyAlgoParticipationPoints ?? 1;
        this.state.dailyAlgoWeekendMultiplier = data.dailyAlgoWeekendMultiplier ?? 1.5;
        this.state.dailyAlgoWeeklyRewardsEnabled = data.dailyAlgoWeeklyRewardsEnabled || false;
        this.state.dailyAlgoWeekRole1Id = data.dailyAlgoWeekRole1Id || '';
        this.state.dailyAlgoWeekRole2Id = data.dailyAlgoWeekRole2Id || '';
        this.state.dailyAlgoWeekRole3Id = data.dailyAlgoWeekRole3Id || '';
        this.state.dailyAlgoWeekRoleRotate = data.dailyAlgoWeekRoleRotate ?? true;
        this.state.dailyAlgoWeekXp1 = data.dailyAlgoWeekXp1 ?? 500;
        this.state.dailyAlgoWeekXp2 = data.dailyAlgoWeekXp2 ?? 300;
        this.state.dailyAlgoWeekXp3 = data.dailyAlgoWeekXp3 ?? 150;
        this.state.dailyAlgoWeekParticipationXp = data.dailyAlgoWeekParticipationXp ?? 100;
        this.state.dailyAlgoWeekAnnouncementChannelId = data.dailyAlgoWeekAnnouncementChannelId || '';
        this.state.dailyAlgoSanctionType = data.dailyAlgoSanctionType || 'WARN';
        this.state.dailyAlgoSanctionWeight = data.dailyAlgoSanctionWeight ?? 1;
        this.state.dailyAlgoSanctionDurationMinutes = data.dailyAlgoSanctionDurationMinutes ?? 60;
        this.state.clanPointsFromDailyAlgo = data.clanPointsFromDailyAlgo || false;
        this.state.clanPointsFromDailyAlgoRate = data.clanPointsFromDailyAlgoRate ?? 1;
        this.state.clanPointsDailyAlgoTop1 = data.clanPointsDailyAlgoTop1 ?? 30;
        this.state.clanPointsDailyAlgoTop2 = data.clanPointsDailyAlgoTop2 ?? 20;
        this.state.clanPointsDailyAlgoTop3 = data.clanPointsDailyAlgoTop3 ?? 10;
        this.state.githubReleasesEnabled = data.githubReleasesEnabled || false;
        this.state.digestEnabled = data.digestEnabled || false;
        this.state.youtubeEnabled = data.youtubeEnabled || false;
        this.state.autoThreadEnabled = data.autoThreadEnabled || false;
        this.state.autoThreadChannels = data.autoThreadChannels || [];
        this.state.funEnabled = data.funEnabled || false;
        this.state.economyEnabled = data.economyEnabled || false;
        this.state.levelingEnabled = data.levelingEnabled || false;
        this.state.isStaffServer = data.isStaffServer || false;
        this.state.funCountingChannelId = data.funCountingChannelId || '';
        this.state.funOneWordStoryChannelId = data.funOneWordStoryChannelId || '';
        this.state.funGuessNumberChannelId = data.funGuessNumberChannelId || '';
        this.state.commandRestrictions = data.commandRestrictions || [];
        this.state.sidebarFavorites = data.sidebarFavorites || [];
        this.state.commandCatalog = data.commandCatalog || [];
        this.state.access = data.access || {
          level: 'moderator',
          canModerateContent: false,
          canModerateDailyAlgo: false,
          canManageSettings: false
        };
        this.state.featureAccess = data.featureAccess || {};
        this.state.modules = data.modules;
        this.state.notifications = data.notifications;
        this.state.auditTrail = this.mergeAuditTrail(this.state.auditTrail, data.auditTrail);
        this.state.sanctions = data.sanctions || [];
        this.state.sanctionReports = data.sanctionReports || [];
        this.state.sanctionTables = data.sanctionTables || [];
        this.state.regulationRules = data.regulationRules || [];
        this.state.messageTemplate = data.messageTemplate;
        this.state.analytics = data.analytics;
        this.state.apprenticeProgress = apprenticeData?.progress;
        this.state.isTutor = !!data.member?.isTutor;
        authStore.member = data.member;
        this.state.error = null;
        this.loadedGuildId = requestedGuildId;
        this.clearRetry();
      }
    } catch (err) {
      if (err?.status === 404) {
        this.state.error = "Le bot n'est pas présent sur ce serveur. Invitez-le pour accéder au tableau de bord.";
      } else if (err?.status === 403) {
        if ((err as any).needsActivation) {
          this.state.error = "activation_requise";
        } else {
          this.state.error = "Vous n'avez pas accès à ce serveur dans le tableau de bord.";
        }
      } else if (err?.status === 500) {
        this.state.error = "L'API du bot a rencontré une erreur interne.";
      } else {
        console.error('DashboardStore sync error:', err);
        this.state.error = "api_unreachable";
        this.scheduleRetry();
      }
    } finally {
      this.state.loading = false;
    }
  }

  private scheduleRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryCount++;
    const delay = Math.min(5000 * this.retryCount, 30000);
    this.retryTimer = setTimeout(() => this.refresh(), delay);
  }

  clearRetry() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryCount = 0;
  }
}

export const dashboardStore = new DashboardStore();
