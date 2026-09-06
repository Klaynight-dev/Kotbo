import { fetchGuildState, fetchApprenticeProgress } from '../api';
import { authStore } from './auth.svelte';

/**
 * Valeurs de repli des blocs structures, partagees entre l'etat initial et la
 * relecture. Les avoir en double laissait l'un des deux deriver, et un bloc
 * absent de la reponse remplacait l'objet par `undefined` : tout composant qui
 * lisait `state.notifications.email` tombait alors sur une erreur.
 */
function createDefaultNotifications() {
  return {
    discordChannel: '#alertes-redaction',
    email: '',
    emailEnabled: false,
    cloudBackup: true,
    debugLog: false,
    killSwitchEnabled: false,
    severityByModule: [] as any[],
  };
}

function createDefaultAnalytics() {
  return {
    activityTrend: [0, 0, 0, 0, 0, 0, 0],
    messagesTrend: [0, 0, 0, 0, 0, 0, 0],
    voiceTrend: [0, 0, 0, 0, 0, 0, 0],
    joinsTrend: [0, 0, 0, 0, 0, 0, 0],
    leavesTrend: [0, 0, 0, 0, 0, 0, 0],
    sanctionsTrend: [0, 0, 0, 0, 0, 0, 0],
    totalAutomations: 0,
    healthStatus: 100,
  };
}

class DashboardStore {
  private retryTimer: any = null;
  private retryCount = 0;

  state = $state({
    guildName: 'Kotbo',
    /** Offre du serveur, telle que `moduleGate` l'applique. */
    plan: 'FREE' as string,
    /**
     * Le serveur n'a rien pris : pas de tableau de bord, un parcours de
     * configuration a la place. Calcule cote bot.
     *
     * `false` au depart et non `true` : avant le premier chargement on ne sait
     * pas, et supposer le parcours ferait clignoter sa coquille devant un
     * abonne a chaque ouverture.
     */
    onboardingRequired: false,
    /**
     * Le dernier ecran du parcours peut se conclure sans paiement : instance
     * sans facturation, ou serveur dont l'acces a deja ete accorde.
     */
    onboardingCanFinishWithoutPayment: false,
    configChannelId: '',
    logChannelId: '',
    logIgnoredChannelIds: [] as string[],
    regulationChannelId: '',
    regulationMessageId: null,
    regulationVerificationEnabled: false,
    regulationRoleId: '',
    regulationLockEnabled: false,
    meetingAnnouncementChannelId: '',
    meetingVoiceChannelId: '',
    publicChannelId: '',
    newsChannelId: '',
    digestChannelId: '',
    dailyAlgoChannelId: '',
    baseStaffRoleId: '',
    testStaffRoleId: '',
    discordChannels: [] as any[],
    discordVoiceChannels: [] as any[],
    discordCategories: [] as any[],
    discordRoles: [] as any[],
    staffRoleIds: [] as string[],
    moderatorRoleId: '',
    propagateSanctions: false,
    crossServerSanctionsEnabled: true,
    sanctionReportEnabled: true,
    sanctionReportSkipBots: false,
    translationEnabled: false,
    codePoliceEnabled: false,
    dailyAlgoEnabled: false,
    analyticsEnabled: true,
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
    adminLockEnabled: false,
    isStaffServer: false,
    funCountingChannelId: '',
    funOneWordStoryChannelId: '',
    funGuessNumberChannelId: '',
    funWordChainChannelId: '',
    funEmojiRiddleChannelId: '',
    funNeverSayChannelId: '',
    funEmojiOnlyChannelId: '',
    funPunitiveMode: true,
    commandRestrictions: [] as any[],
    sidebarFavorites: [] as string[],
    commandCatalog: [] as any[],
    access: {
      level: 'none',
      canModerateContent: false,
      canModerateDailyAlgo: false,
      canManageSettings: false
    },
    featureAccess: {} as Record<string, {
      canView?: boolean;
      canModerate?: boolean;
      canConfigure?: boolean;
      canDelete?: boolean;
    }>,
    modules: [],
    /** Etat de chaque module tel que le bot lapplique, cle canonique -> actif. */
    moduleStates: {} as Record<string, boolean>,
    /**
     * Incremente a chaque module rallume. Les pages chargent leur configuration
     * au montage ; tant que le module etait eteint ce chargement se prenait un
     * 403, et rien ne le rejouait - il fallait recharger le navigateur pour
     * voir la page vivante. `LazyPage` remonte la page courante quand ce
     * compteur bouge.
     */
    moduleActivationEpoch: 0,
    notifications: createDefaultNotifications(),
    auditTrail: [] as any[],
    sanctions: [] as any[],
    sanctionReports: [] as any[],
    sanctionTables: [] as any[],
    statusCheckChannelId: '',
    regulationRules: [] as any[],
    messageTemplate: '',
    analytics: createDefaultAnalytics(),
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
   * Serveur et portee du rafraichissement en vol. Un appel qui charge tout
   * l'etat du bon serveur repond aussi a une demande d'apercu : sans ces deux
   * reperes on ne pouvait pas le savoir, et chaque appelant en relancait un de
   * son cote. Le serveur en fait partie : reutiliser l'appel d'un autre laisse
   * l'appelant croire le sien charge.
   */
  private pendingFull = false;
  private pendingGuildId: string | null = null;
  /**
   * Guild pour laquelle un `refresh()` a deja abouti. Sert a distinguer le
   * premier chargement (qui doit afficher un etat d'attente) des
   * rafraichissements en arriere-plan. Compare a la guild courante plutot que
   * pilote depuis `authStore`, pour eviter un import circulaire entre les deux
   * stores.
   */
  private loadedGuildId: string | null = null;
  private fullyLoadedGuildId: string | null = null;

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

  /** A appeler apres avoir rallume un module, une fois l'etat rafraichi. */
  markModuleActivated(): void {
    this.state.moduleActivationEpoch += 1;
  }

  async refresh(options: { full?: boolean } = {}): Promise<void> {
    const requestedGuildId = authStore.selectedGuildId;
    const full = options.full
      ?? (typeof window === 'undefined' || window.location.pathname !== '/');

    const inFlight = this.refreshPromise;
    if (inFlight) {
      // Un appel deja parti couvre le besoin : on se raccroche au sien au lieu
      // d'en lancer un second sur les memes routes.
      if (this.covers(requestedGuildId, full)) return inFlight;

      // Sinon il ne repond pas a la demande - autre serveur, ou simple apercu
      // la ou il faut tout l'etat. On l'attend avant de relancer, sinon les
      // deux reponses s'ecrasent l'une l'autre.
      await inFlight;
      if (this.isLoadedFor(requestedGuildId, full)) return;
    }

    return this.startRefresh(full);
  }

  /** Le rafraichissement en vol repond-il deja a cette demande ? */
  private covers(guildId: string | null, full: boolean): boolean {
    if (!this.refreshPromise) return false;
    if (this.pendingGuildId !== guildId) return false;
    return this.pendingFull || !full;
  }

  /** Vrai si l'etat affiche correspond deja a ce que l'appelant demande. */
  private isLoadedFor(guildId: string | null, full: boolean): boolean {
    return full ? this.fullyLoadedGuildId === guildId : this.loadedGuildId === guildId;
  }

  private startRefresh(full: boolean): Promise<void> {
    // Le serveur vise est celui d'ici, pas celui capture avant l'attente
    // ci-dessus : c'est aussi celui que `runRefresh` va lire.
    const guildId = authStore.selectedGuildId;

    // Plusieurs appelants peuvent avoir attendu le meme rafraichissement et
    // repartir ensemble : le premier reveille lance le suivant, les autres
    // doivent s'y raccrocher plutot que d'en empiler un chacun.
    if (this.covers(guildId, full)) return this.refreshPromise!;

    if (!authStore.token || !guildId) {
      this.state.loading = false;
      return Promise.resolve();
    }

    const pending = this.runRefresh(full);
    this.refreshPromise = pending;
    this.pendingFull = full;
    this.pendingGuildId = guildId;
    return pending.finally(() => {
      // Ne libere le verrou que s'il s'agit toujours du notre : un appel parti
      // entre-temps garde la main sur le sien.
      if (this.refreshPromise === pending) {
        this.refreshPromise = null;
        this.pendingFull = false;
        this.pendingGuildId = null;
      }
    });
  }

  async ensureFullState(): Promise<void> {
    if (this.fullyLoadedGuildId === authStore.selectedGuildId) return;
    await this.refresh({ full: true });
  }

  /**
   * La progression d'apprenti n'existe que si le module Tutorat tourne : sinon
   * l'API ferme la route (403 `module_disabled`) et l'appel ne rapporte rien.
   * Comme ce rafraichissement part a chaque chargement de page, le refus se
   * repetait partout dans l'interface. On ne s'en passe que si la liste des
   * modules deja chargee decrit bien la guild visee - sur un changement de
   * serveur, elle decrit encore le precedent et ne prouve rien.
   */
  private tutoringLooksDisabled(guildId: string | null): boolean {
    if (!guildId || this.loadedGuildId !== guildId) return false;
    const modules = (this.state.modules ?? []) as Array<{ id: string; status: string }>;
    const tutoring = modules.find((entry) => entry.id === 'tutoring');
    return !!tutoring && tutoring.status !== 'active';
  }

  private async runRefresh(full: boolean): Promise<void> {
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
      this.state.onboardingRequired = false;
      this.state.onboardingCanFinishWithoutPayment = false;
    }

    try {
      const [data, apprenticeData] = await Promise.all([
        fetchGuildState(requestedGuildId, { overview: !full }),
        this.tutoringLooksDisabled(requestedGuildId)
          ? Promise.resolve({ progress: null })
          : fetchApprenticeProgress().catch(() => ({ progress: null }))
      ]);

      // L'utilisateur a change de serveur pendant la requete : ces donnees
      // decrivent le precedent. Les appliquer afficherait le contenu de l'un
      // sous le nom de l'autre, et `loadedGuildId` aurait certifie a jour un
      // etat qui ne l'est pas. Le changement de serveur a declenche son propre
      // rafraichissement, il n'y a rien a rattraper ici.
      if (authStore.selectedGuildId !== requestedGuildId) return;

      if (data) {
        this.state.guildName = data.guildName;
        this.state.plan = data.plan ?? 'FREE';
        this.state.onboardingRequired = Boolean(data.onboardingRequired);
        this.state.onboardingCanFinishWithoutPayment = Boolean(data.onboardingCanFinishWithoutPayment);
        this.state.configChannelId = data.configChannelId || '';
        this.state.logChannelId = data.logChannelId || '';
        this.state.logIgnoredChannelIds = data.logIgnoredChannelIds || [];
        this.state.regulationChannelId = data.regulationChannelId || '';
        this.state.regulationMessageId = data.regulationMessageId || null;
        this.state.regulationVerificationEnabled = data.regulationVerificationEnabled || false;
        this.state.regulationRoleId = data.regulationRoleId || '';
        this.state.regulationLockEnabled = data.regulationLockEnabled || false;
        this.state.meetingAnnouncementChannelId = data.meetingAnnouncementChannelId || '';
        this.state.meetingVoiceChannelId = data.meetingVoiceChannelId || '';
        this.state.publicChannelId = data.publicChannelId || '';
        this.state.newsChannelId = data.newsChannelId || '';
        this.state.digestChannelId = data.digestChannelId || '';
        this.state.dailyAlgoChannelId = data.dailyAlgoChannelId || '';
        this.state.baseStaffRoleId = data.baseStaffRoleId || '';
        this.state.testStaffRoleId = data.testStaffRoleId || '';
        this.state.discordChannels = data.discordChannels || [];
        this.state.discordVoiceChannels = data.discordVoiceChannels || [];
        this.state.discordCategories = data.discordCategories || [];
        this.state.discordRoles = data.discordRoles || [];
        this.state.staffRoleIds = data.staffRoleIds || [];
        this.state.moderatorRoleId = data.moderatorRoleId || '';
        this.state.propagateSanctions = data.propagateSanctions || false;
        this.state.crossServerSanctionsEnabled = data.crossServerSanctionsEnabled ?? true;
        this.state.sanctionReportEnabled = data.sanctionReportEnabled ?? true;
        this.state.sanctionReportSkipBots = data.sanctionReportSkipBots ?? false;
        this.state.translationEnabled = data.translationEnabled || false;
        this.state.codePoliceEnabled = data.codePoliceEnabled || false;
        this.state.dailyAlgoEnabled = data.dailyAlgoEnabled || false;
        this.state.analyticsEnabled = data.analyticsEnabled ?? true;
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
        this.state.adminLockEnabled = data.adminLockEnabled || false;
        this.state.isStaffServer = data.isStaffServer || false;
        this.state.funCountingChannelId = data.funCountingChannelId || '';
        this.state.funOneWordStoryChannelId = data.funOneWordStoryChannelId || '';
        this.state.funGuessNumberChannelId = data.funGuessNumberChannelId || '';
        this.state.funWordChainChannelId = data.funWordChainChannelId || '';
        this.state.funEmojiRiddleChannelId = data.funEmojiRiddleChannelId || '';
        this.state.funNeverSayChannelId = data.funNeverSayChannelId || '';
        this.state.funEmojiOnlyChannelId = data.funEmojiOnlyChannelId || '';
        this.state.funPunitiveMode = data.funPunitiveMode ?? true;
        this.state.commandRestrictions = data.commandRestrictions || [];
        this.state.sidebarFavorites = data.sidebarFavorites || [];
        this.state.commandCatalog = data.commandCatalog || [];
        this.state.access = data.access || {
          level: 'none',
          canModerateContent: false,
          canModerateDailyAlgo: false,
          canManageSettings: false
        };
        this.state.featureAccess = data.featureAccess || {};
        this.state.modules = data.modules || [];
        this.state.notifications = data.notifications || createDefaultNotifications();
        this.state.auditTrail = this.mergeAuditTrail(this.state.auditTrail, data.auditTrail);
        this.state.sanctions = data.sanctions || [];
        this.state.sanctionReports = data.sanctionReports || [];
        this.state.sanctionTables = data.sanctionTables || [];
        this.state.regulationRules = data.regulationRules || [];
        this.state.messageTemplate = data.messageTemplate || '';
        this.state.analytics = data.analytics || createDefaultAnalytics();
        this.state.apprenticeProgress = apprenticeData?.progress;
        this.state.isTutor = !!data.member?.isTutor;
        authStore.member = data.member;
        this.state.error = null;
        this.loadedGuildId = requestedGuildId;
        if (full) this.fullyLoadedGuildId = requestedGuildId;
        this.clearRetry();
      }
    } catch (err) {
      // Meme raison que pour le chemin nominal : une erreur qui concerne le
      // serveur qu'on vient de quitter ne doit pas s'afficher par-dessus le
      // chargement du nouveau.
      if (authStore.selectedGuildId !== requestedGuildId) return;

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
      // Un appel devenu obsolete a rendu la main sans rien ecrire : eteindre
      // `loading` ici couperait l'ecran d'attente du rafraichissement qui a
      // pris sa suite et qui, lui, est toujours en vol.
      if (authStore.selectedGuildId === requestedGuildId) {
        this.state.loading = false;
      }
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
