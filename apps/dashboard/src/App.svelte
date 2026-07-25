<script lang="ts">
  import { onMount } from "svelte";
  import { Route as RouteLegacy, router } from "tinro";
  const Route = RouteLegacy as any;
  import MainLayout from "./lib/components/MainLayout.svelte";
  import { authStore } from "./lib/stores/auth.svelte";
  import { dashboardStore } from "./lib/stores/dashboard.svelte";
  import { brandingStore } from "./lib/stores/branding.svelte";
  import { themeStore } from "./lib/stores/theme.svelte";
  import { userPrefs } from "./lib/stores/userPreferences.svelte";
  import { toast } from "./lib/stores/toast.svelte";
  import { feedbackModal } from "./lib/stores/feedbackModal.svelte";
  import { inviteDetailsModal } from "./lib/stores/inviteDetailsModal.svelte";
  import ToastContainer from "./lib/components/ToastContainer.svelte";
  import GlobalConfirmDialog from "./lib/components/GlobalConfirmDialog.svelte";
  import CommandPalette from "./lib/components/CommandPalette.svelte";
  import NotFound from "./pages/NotFound.svelte";
  import GlobalErrorOverlay from "./lib/components/GlobalErrorOverlay.svelte";
  import LazyRoute from "./lib/components/LazyRoute.svelte";
  import { m } from "./lib/i18n";

  let globalError = $state<{ message: string; stack?: string } | null>(null);
  let showKeyboardShortcuts = $state(false);

  $effect(() => {
    if (authStore.selectedGuildId && authStore.isAuthenticated) {
      userPrefs.syncFromDatabase();
    }
  });

  // Seules les pages du chemin critique restent en import statique : elles font
  // partie du premier rendu (ecran de connexion, accueil, 404). Toutes les
  // autres passent par <LazyRoute> et sont chargees a la demande — voir
  // src/lib/lazyRoutes.ts.
  import Login from "./pages/Login.svelte";
  import Activation from "./pages/Activation.svelte";

  const isPublicPage = $derived(
    /^\/\d{17,19}\/news\/?$/.test($router.path) ||
      /^\/\d{17,19}\/leveling\/classement\/?$/.test($router.path) ||
      /^\/\d{17,19}\/leveling\/clan\/?$/.test($router.path) ||
      /^\/\d{17,19}\/clan\/?$/.test($router.path) ||
      ($router.path.startsWith("/profile/") && !authStore.isAuthenticated) ||
      $router.path.startsWith("/transcripts/") ||
      $router.path.startsWith("/sanction-evidence/") ||
      $router.path.startsWith("/form/") ||
      $router.path.startsWith("/appeal/") ||
      $router.path.startsWith("/verify/"),
  );

  const featureAccess = $derived(dashboardStore.state.featureAccess || {});
  const fallbackCanView = $derived(
    authStore.guilds.find((guild) => guild.id === authStore.selectedGuildId)
      ?.accessLevel !== "none",
  );

  function canViewFeature(featureKey: string) {
    if (!featureKey) return true;
    const feature = (featureAccess as Record<string, any>)?.[featureKey];
    if (feature?.canView !== undefined) return feature.canView;
    return fallbackCanView;
  }

  function resolveRouteFeatureKey(path: string): string | null {
    if (path === "/" || path.startsWith("/profile")) return "dashboard";
    if (path.startsWith("/analytics")) return "analytics";
    if (path.startsWith("/inbox")) return "inbox";
    if (path.startsWith("/dailyalgo")) return "daily_algo";
    if (path.startsWith("/events")) return "events";
    if (path.startsWith("/members") || path.startsWith("/invitations"))
      return "members";
    if (path.startsWith("/sanctions")) return "sanctions";
    if (path.startsWith("/appeals")) return "sanctions";
    if (path.startsWith("/nickname-moderation")) return "nickname_moderation";
    if (path.startsWith("/channels-management")) return "auto_thread";
    if (path.startsWith("/detections")) return "double_accounts";
    if (path.startsWith("/double-accounts")) return "double_accounts";
    if (path.startsWith("/logs")) return "logs";
    if (path.startsWith("/activity")) return "activity";
    if (path.startsWith("/recruitment")) return "recruitment";
    if (path.startsWith("/tickets")) return "tickets";
    if (path.startsWith("/tutoring")) return "tutoring";
    if (path.startsWith("/meetings")) return "absences";
    if (path.startsWith("/absences")) return "absences";
    if (path.startsWith("/planning")) return "absences";
    if (path.startsWith("/leveling")) return "leveling";
    if (path.startsWith("/economy")) return "economy";
    if (path.startsWith("/giveaways")) return "giveaways";
    if (path.startsWith("/welcome") || path.startsWith("/announcement")) return "welcome_goodbye";
    if (path.startsWith("/reaction-roles")) return "reaction_roles";
    if (path.startsWith("/triggers")) return "auto_responses";
    if (path.startsWith("/automod")) return "automod";
    if (path.startsWith("/admin-lock")) return "automod";
    if (path.startsWith("/suggestions")) return "suggestions";
    if (path.startsWith("/embed-builder")) return "embed_builder";
    if (path.startsWith("/staff-management")) {
      const segment = path.split('/')[2] || '';
      if (segment === "roles") return "staff_roles";
      if (segment === "polls") return "polls";
      if (segment === "warnings") return "discipline";
      if (segment === "leadership") return "staff_directory";
      return "staff_directory";
    }
    if (path.startsWith("/evaluations")) return "staff_directory";
    if (path.startsWith("/modules")) return "modules";
    if (path.startsWith("/command-access")) return "commands";
    if (path.startsWith("/settings")) return "settings";
    if (path.startsWith("/regulation")) return "regulation";
    if (path.startsWith("/news")) return "news";
    if (path.startsWith("/social-networks")) return "social_networks";
    if (path.startsWith("/backups")) return "settings";
    if (path.startsWith("/schedules")) return "settings";
    if (path.startsWith("/mcp-settings")) return "settings";
    if (path.startsWith("/fun")) return "fun";
    if (path.startsWith("/channel-health")) return "channel_health";
    if (path.startsWith("/channel-links")) return "channel_links";
    if (path.startsWith("/staff-server")) return "staff_server";
    if (path.startsWith("/widget")) return "dashboard";
    if (path.startsWith("/admin")) return "centralized_config";
    return null;
  }

  function navigate(node: HTMLElement, path: string) {
    router.goto(path);
  }

  function selectedGuildAccessLevel() {
    const selectedGuild = authStore.guilds.find(
      (guild) => guild.id === authStore.selectedGuildId,
    );
    return selectedGuild?.accessLevel || "admin";
  }

  const canManageSettings = $derived(
    selectedGuildAccessLevel() !== "moderator",
  );

  onMount(() => {
    brandingStore.load();

    // Remove credentials left by the retired fragment-based OAuth flow.
    const urlParams = new URLSearchParams(window.location.search);
    let token = urlParams.get("token");

    if (!token && window.location.hash) {
      const hashParams = new URLSearchParams(window.location.hash.substring(1));
      token = hashParams.get("token");
    }

    if (token) {
      authStore.setToken(token);
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    void authStore.initialize().then(() => {
      if (!authStore.isAuthenticated && $router.path !== "/login" && !isPublicPage) {
        router.goto("/login");
      } else if (authStore.isAuthenticated && $router.path === "/login") {
        router.goto("/");
      }
    });

    const timer = setTimeout(() => {
      sessionStorage.removeItem("error_refreshed");
    }, 5000);

    // Keyboard shortcuts
    let gKeyPressed = false;
    let gKeyTimeout: number | null = null;

    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      const isEditing = activeEl && (
        activeEl.tagName === 'INPUT' ||
        activeEl.tagName === 'TEXTAREA' ||
        activeEl.tagName === 'SELECT' ||
        activeEl.getAttribute('contenteditable') === 'true'
      );

      if (isEditing) return;

      // Check for Ctrl + Shift + key combinations
      if (e.ctrlKey && e.shiftKey) {
        switch (e.key.toLowerCase()) {
          case 'd':
            e.preventDefault();
            router.goto("/");
            break;
          case 'm':
            e.preventDefault();
            router.goto("/members");
            break;
          case 'c':
            e.preventDefault();
            router.goto("/settings");
            break;
          case 'l':
            e.preventDefault();
            router.goto("/activity");
            break;
          case 'n':
            e.preventDefault();
            showKeyboardShortcuts = true;
            break;
        }
        return;
      }

      // Handle G then key sequences
      if (e.key.toLowerCase() === 'g' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        gKeyPressed = true;
        if (gKeyTimeout) clearTimeout(gKeyTimeout);
        gKeyTimeout = window.setTimeout(() => {
          gKeyPressed = false;
        }, 1000);
        return;
      }

      if (gKeyPressed) {
        switch (e.key.toLowerCase()) {
          case 'd':
            e.preventDefault();
            router.goto("/");
            gKeyPressed = false;
            if (gKeyTimeout) clearTimeout(gKeyTimeout);
            break;
          case 'm':
            e.preventDefault();
            router.goto("/members");
            gKeyPressed = false;
            if (gKeyTimeout) clearTimeout(gKeyTimeout);
            break;
          case 'c':
            e.preventDefault();
            router.goto("/settings");
            gKeyPressed = false;
            if (gKeyTimeout) clearTimeout(gKeyTimeout);
            break;
          case 'l':
            e.preventDefault();
            router.goto("/activity");
            gKeyPressed = false;
            if (gKeyTimeout) clearTimeout(gKeyTimeout);
            break;
        }
      }
    };

    // Fonction nommee : `removeEventListener` compare les references, donc une
    // fonction anonyme recreee au nettoyage ne retire jamais le listener.
    const handleOpenKeyboardShortcuts = () => {
      showKeyboardShortcuts = true;
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener(
      "open-keyboard-shortcuts",
      handleOpenKeyboardShortcuts,
    );

    // Global error handling — ignores network/abort errors from WS reconnections
    // and Vite dev-server internal errors to avoid infinite feedback loops
    const IGNORED_MESSAGES = [
      "Failed to fetch",
      "NetworkError",
      "Load failed",
      "AbortError",
      "The operation was aborted",
      // Vite dev-server WS errors (would cause infinite loop if logged via console)
      "send was called before connect",
      "WebSocket is closed",
    ];

    // Re-entrancy guard: prevents the handler from triggering itself
    let isHandlingRejection = false;

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (isHandlingRejection) {
        event.preventDefault();
        return;
      }

      const reason = event.reason;
      const message: string = reason?.message || String(reason) || "";

      // Silently ignore network errors (e.g. from WS reconnect / API temporarily down)
      if (IGNORED_MESSAGES.some((ignored) => message.includes(ignored))) {
        event.preventDefault(); // Suppress browser console error too
        return;
      }

      isHandlingRejection = true;
      try {
        // Use queueMicrotask to avoid calling toast synchronously during Vite init
        queueMicrotask(() => {
          globalError = {
            message:
              message ||
              m.d3_err_unexpected_promise(),
            stack: reason?.stack || undefined,
          };
          toast.error(message || m.d3_err_unexpected());
          isHandlingRejection = false;
        });
      } catch {
        isHandlingRejection = false;
      }
    };

    const handleError = (event: ErrorEvent) => {
      // Only show toast for non-script-load errors
      if (
        event.message &&
        !IGNORED_MESSAGES.some((m) => event.message.includes(m))
      ) {
        globalError = {
          message: event.message || m.d3_err_generic(),
          stack: event.error?.stack || undefined,
        };
        toast.error(event.message || m.d3_err_generic());
      }
    };

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);

    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener(
        "open-keyboard-shortcuts",
        handleOpenKeyboardShortcuts,
      );
      window.removeEventListener("error", handleError);
      window.removeEventListener(
        "unhandledrejection",
        handleUnhandledRejection,
      );
    };
  });

  $effect(() => {
    if (!authStore.initialized) return;
    if (
      !authStore.isAuthenticated &&
      $router.path !== "/login" &&
      !isPublicPage
    ) {
      router.goto("/login");
      return;
    }

    if (authStore.isAuthenticated && !isPublicPage) {
      const featureKey = resolveRouteFeatureKey($router.path);
      if (featureKey && !canViewFeature(featureKey)) {
        if ($router.path !== "/") {
          router.goto("/");
        }
      }
    }
  });
</script>

{#snippet handleLegacyRedirect(moduleId: string)}
  {@const mapping: Record<string, string> = {
    'regulation': '/regulation',
    'sanctions': '/sanctions',
    'logs': '/logs',
    'recruitment': '/recruitment',
    'tickets': '/tickets',
    'meetings': '/planning',
    'fun': '/fun',
    'dailyalgo': $router.query.submissionId ? `/dailyalgo/ide?submissionId=${$router.query.submissionId}` : '/dailyalgo'
  }}
  {@const target = mapping[moduleId] || "/modules"}
  <div use:navigate={target}></div>
{/snippet}

{#if globalError}
  <GlobalErrorOverlay
    errorMsg={globalError.message}
    errorStack={globalError.stack}
  />
{:else}
  <svelte:boundary>
    {#if isPublicPage}
      <LazyRoute
        path="/:serverId/news"
        load={() => import("./pages/News.svelte")}
        props={(meta) => ({ serverId: meta.params.serverId })}
      />
      <LazyRoute
        path="/:serverId/leveling/classement"
        load={() => import("./pages/LevelingPublic.svelte")}
        props={(meta) => ({ serverId: meta.params.serverId })}
      />
      <LazyRoute
        path="/:serverId/leveling/clan"
        load={() => import("./pages/LevelingClanPublic.svelte")}
        props={(meta) => ({ serverId: meta.params.serverId })}
      />
      <LazyRoute
        path="/:serverId/clan"
        load={() => import("./pages/LevelingClanPublic.svelte")}
        props={(meta) => ({ serverId: meta.params.serverId })}
      />
      <LazyRoute
        path="/profile/:userId"
        load={() => import("./pages/PublicProfile.svelte")}
        props={(meta) => ({ userId: meta.params.userId })}
      />
      <LazyRoute
        path="/transcripts/:transcriptId"
        load={() => import("./pages/TranscriptDetail.svelte")}
        props={(meta) => ({ transcriptId: meta.params.transcriptId })}
      />
      <LazyRoute
        path="/sanction-evidence/:fileId"
        load={() => import("./pages/SanctionEvidenceFile.svelte")}
        props={(meta) => ({ fileId: meta.params.fileId })}
      />
      <LazyRoute
        path="/form/:formId"
        load={() => import("./pages/PublicForm.svelte")}
        props={(meta) => ({ formId: meta.params.formId })}
      />
      <LazyRoute
        path="/appeal/:guildId"
        load={() => import("./pages/PublicAppeal.svelte")}
        props={(meta) => ({ guildId: meta.params.guildId })}
      />
      <LazyRoute
        path="/verify/:guildId/:token"
        load={() => import("./pages/Verify.svelte")}
        props={(meta) => ({ guildId: meta.params.guildId, token: meta.params.token })}
      />

      <LazyRoute
        path="/analytics/*"
        load={() => import("./pages/Analytics.svelte")}
      />
      <LazyRoute
        path="/activity"
        load={() => import("./pages/ActivityLog.svelte")}
      />
      {#if authStore.isBotAdmin}
        <LazyRoute
          path="/admin"
          load={() => import("./pages/admin/Overview.svelte")}
        />
        <LazyRoute
          path="/admin/servers"
          load={() => import("./pages/admin/Servers.svelte")}
        />
        <LazyRoute
          path="/admin/shards"
          load={() => import("./pages/admin/Shards.svelte")}
        />
        <LazyRoute
          path="/admin/security"
          load={() => import("./pages/admin/Security.svelte")}
        />
        <LazyRoute
          path="/admin/content"
          load={() => import("./pages/admin/Content.svelte")}
        />
        <LazyRoute
          path="/admin/config"
          load={() => import("./pages/admin/Config.svelte")}
        />
        <LazyRoute
          path="/admin/activation"
          load={() => import("./pages/admin/Activation.svelte")}
        />
        <LazyRoute
          path="/admin/modules"
          load={() => import("./pages/admin/Modules.svelte")}
        />
        <LazyRoute
          path="/admin/whitelabel"
          load={() => import("./pages/admin/WhiteLabel.svelte")}
        />
        <LazyRoute
          path="/admin/broadcast"
          load={() => import("./pages/admin/Broadcast.svelte")}
        />
        <LazyRoute
          path="/admin/gdpr"
          load={() => import("./pages/admin/Gdpr.svelte")}
        />
      {/if}
      <LazyRoute
        path="/logs/*"
        load={() => import("./pages/Logs.svelte")}
      />
      <LazyRoute
        path="/sanctions/*"
        load={() => import("./pages/Sanctions.svelte")}
      />
      <LazyRoute
        path="/appeals"
        load={() => import("./pages/BanAppeals.svelte")}
      />
      <LazyRoute
        path="/admin-lock"
        load={() => import("./pages/AdminLockRequests.svelte")}
      />
      <Route path="/detections">
        <div use:navigate={"/double-accounts/detections"}></div>
      </Route>
      <LazyRoute
        path="/regulation"
        load={() => import("./pages/Regulation.svelte")}
      />
      <LazyRoute
        path="/profile"
        load={() => import("./pages/Profile.svelte")}
      />
      {#if canManageSettings}
        <LazyRoute
          path="/modules"
          load={() => import("./pages/ModuleCatalog.svelte")}
        />
        <Route path="/module-settings/:moduleId" let:meta>
          <!-- Simple redirect logic for legacy URLs -->
          {@render handleLegacyRedirect(meta.params.moduleId)}
        </Route>
        <LazyRoute
          path="/notifications"
          load={() => import("./pages/NotificationsSettings.svelte")}
        />
        <LazyRoute
          path="/command-access/*"
          load={() => import("./pages/CommandAccess.svelte")}
        />
        <LazyRoute
          path="/settings"
          load={() => import("./pages/GeneralSettings.svelte")}
        />
        <LazyRoute
          path="/automations"
          load={() => import("./pages/ModuleCatalog.svelte")}
        />
        <LazyRoute
          path="/staff-management/*"
          load={() => import("./pages/StaffManagement.svelte")}
        />
        <LazyRoute
          path="/channels-management/*"
          load={() => import("./pages/ChannelsManagement.svelte")}
        />
      {/if}

      <LazyRoute
        path="/dailyalgo"
        load={() => import("./pages/DailyAlgo.svelte")}
      />
      <LazyRoute
        path="/members/*"
        load={() => import("./pages/Members.svelte")}
      />
      <LazyRoute
        path="/recruitment"
        load={() => import("./pages/Recruitment.svelte")}
      />
      <LazyRoute
        path="/tickets"
        load={() => import("./pages/Tickets.svelte")}
      />
      <LazyRoute
        path="/transcripts-list"
        load={() => import("./pages/Transcripts.svelte")}
      />
      <LazyRoute
        path="/message-search"
        load={() => import("./pages/MessageSearch.svelte")}
      />
      <LazyRoute
        path="/meetings"
        load={() => import("./pages/Meetings.svelte")}
      />
      <Route path="/absences">
        <div use:navigate={"/planning"}></div>
      </Route>
      <LazyRoute
        path="/planning/*"
        load={() => import("./pages/Planning.svelte")}
      />
      <LazyRoute
        path="/inbox/*"
        load={() => import("./pages/Inbox.svelte")}
      />
      <LazyRoute
        path="/tutoring"
        load={() => import("./pages/Tutoring.svelte")}
      />
      <LazyRoute
        path="/double-accounts/*"
        load={() => import("./pages/DoubleAccounts.svelte")}
      />
      <LazyRoute
        path="/invitations/:code"
        load={() => import("./pages/InvitationDetail.svelte")}
        props={(meta) => ({ code: meta.params.code })}
        remountKey={(meta) => meta.params.code}
      />
      <LazyRoute
        path="/invitations/*"
        load={() => import("./pages/Invitations.svelte")}
      />

      <LazyRoute
        path="/backups"
        load={() => import("./pages/Backups.svelte")}
      />
      <LazyRoute
        path="/schedules"
        load={() => import("./pages/Schedules.svelte")}
      />
      <LazyRoute
        path="/mcp-settings"
        load={() => import("./pages/MCPSettings.svelte")}
      />
      <LazyRoute
        path="/custom-bot"
        load={() => import("./pages/CustomBot.svelte")}
      />

      <LazyRoute
        path="/events"
        load={() => import("./pages/Events.svelte")}
      />
      <LazyRoute
        path="/events/edit/:eventId"
        load={() => import("./pages/EventEditor.svelte")}
        props={(meta) => ({ eventId: meta.params.eventId })}
      />
      <LazyRoute
        path="/events/control/:eventId"
        load={() => import("./pages/EventControl.svelte")}
        props={(meta) => ({ eventId: meta.params.eventId })}
      />

      <LazyRoute
        path="/userSettings"
        load={() => import("./pages/UserSettings.svelte")}
      />

      <!-- Fallback for authenticated users -->
      <Route fallback>
        <NotFound />
      </Route>
    {:else}
      <Route path="/login">
        <Login />
      </Route>

      {#if authStore.isAuthenticated}
        {#if dashboardStore.state.error === "activation_requise"}
          <Route path="/*">
            <Activation />
          </Route>
        {:else if $router.path === "/dailyalgo/ide"}
          <LazyRoute
            path="/dailyalgo/ide"
            load={() => import("./pages/DailyAlgoIDE.svelte")}
          />
        {:else}
          <MainLayout>
            <LazyRoute
              path="/"
              load={() => import("./pages/Home.svelte")}
            />

            <LazyRoute
              path="/analytics/*"
              load={() => import("./pages/Analytics.svelte")}
            />
            <LazyRoute
              path="/activity"
              load={() => import("./pages/ActivityLog.svelte")}
            />
            {#if authStore.isBotAdmin}
              <LazyRoute
                path="/admin"
                load={() => import("./pages/admin/Overview.svelte")}
              />
              <LazyRoute
                path="/admin/servers"
                load={() => import("./pages/admin/Servers.svelte")}
              />
              <LazyRoute
                path="/admin/shards"
                load={() => import("./pages/admin/Shards.svelte")}
              />
              <LazyRoute
                path="/admin/security"
                load={() => import("./pages/admin/Security.svelte")}
              />
              <LazyRoute
                path="/admin/content"
                load={() => import("./pages/admin/Content.svelte")}
              />
              <LazyRoute
                path="/admin/config"
                load={() => import("./pages/admin/Config.svelte")}
              />
              <LazyRoute
                path="/admin/activation"
                load={() => import("./pages/admin/Activation.svelte")}
              />
              <LazyRoute
                path="/admin/modules"
                load={() => import("./pages/admin/Modules.svelte")}
              />
              <LazyRoute
                path="/admin/whitelabel"
                load={() => import("./pages/admin/WhiteLabel.svelte")}
              />
              <LazyRoute
                path="/admin/broadcast"
                load={() => import("./pages/admin/Broadcast.svelte")}
              />
              <LazyRoute
                path="/admin/gdpr"
                load={() => import("./pages/admin/Gdpr.svelte")}
              />
            {/if}
            <LazyRoute
              path="/logs/*"
              load={() => import("./pages/Logs.svelte")}
            />
            <LazyRoute
              path="/sanctions/*"
              load={() => import("./pages/Sanctions.svelte")}
            />
            <LazyRoute
              path="/appeals"
              load={() => import("./pages/BanAppeals.svelte")}
            />
            <LazyRoute
              path="/admin-lock"
              load={() => import("./pages/AdminLockRequests.svelte")}
            />
            <Route path="/detections">
              <div use:navigate={"/double-accounts/detections"}></div>
            </Route>
            <LazyRoute
              path="/regulation"
              load={() => import("./pages/Regulation.svelte")}
            />
            <LazyRoute
              path="/news/*"
              load={() => import("./pages/News.svelte")}
            />
            <LazyRoute
              path="/social-networks/*"
              load={() => import("./pages/SocialNetworks.svelte")}
            />
            <LazyRoute
              path="/profile/:userId"
              load={() => import("./pages/Profile.svelte")}
              props={(meta) => ({ userId: meta.params.userId })}
            />
            <LazyRoute
              path="/profile/*"
              load={() => import("./pages/Profile.svelte")}
            />
            {#if canManageSettings}
              <LazyRoute
                path="/modules"
                load={() => import("./pages/ModuleCatalog.svelte")}
              />
              <Route path="/module-settings/:moduleId" let:meta>
                <!-- Simple redirect logic for legacy URLs -->
                {@render handleLegacyRedirect(meta.params.moduleId)}
              </Route>
              <LazyRoute
                path="/notifications"
                load={() => import("./pages/NotificationsSettings.svelte")}
              />
              <LazyRoute
                path="/command-access/*"
                load={() => import("./pages/CommandAccess.svelte")}
              />
              <LazyRoute
                path="/settings"
                load={() => import("./pages/GeneralSettings.svelte")}
              />
              <LazyRoute
                path="/backups"
                load={() => import("./pages/Backups.svelte")}
              />
              <LazyRoute
                path="/schedules"
                load={() => import("./pages/Schedules.svelte")}
              />
              <LazyRoute
                path="/mcp-settings"
                load={() => import("./pages/MCPSettings.svelte")}
              />
              <LazyRoute
                path="/custom-bot"
                load={() => import("./pages/CustomBot.svelte")}
              />
              <LazyRoute
                path="/automations"
                load={() => import("./pages/ModuleCatalog.svelte")}
              />
              <LazyRoute
                path="/staff-management/*"
                load={() => import("./pages/StaffManagement.svelte")}
              />
              <LazyRoute
                path="/channels-management/*"
                load={() => import("./pages/ChannelsManagement.svelte")}
              />
            {/if}

            <LazyRoute
              path="/channel-health/*"
              load={() => import("./pages/ChannelHealth.svelte")}
            />
            <LazyRoute
              path="/pulse/*"
              load={() => import("./pages/Pulse.svelte")}
            />
            <LazyRoute
              path="/reputation"
              load={() => import("./pages/Reputation.svelte")}
            />
            <Route path="/satisfaction">
              <div use:navigate={"/tickets"}></div>
            </Route>
            <LazyRoute
              path="/seasons"
              load={() => import("./pages/Seasons.svelte")}
            />
            <Route path="/predictions">
              <div use:navigate={"/pulse"}></div>
            </Route>
            <LazyRoute
              path="/evaluations"
              load={() => import("./pages/Evaluations.svelte")}
            />
            <LazyRoute
              path="/marketplace/*"
              load={() => import("./pages/Marketplace.svelte")}
            />
            <LazyRoute
              path="/quests"
              load={() => import("./pages/Quests.svelte")}
            />
            <LazyRoute
              path="/widget"
              load={() => import("./pages/Widget.svelte")}
            />
            <LazyRoute
              path="/channel-links"
              load={() => import("./pages/ChannelLinks.svelte")}
            />
            <LazyRoute
              path="/staff-server"
              load={() => import("./pages/StaffServerLinks.svelte")}
            />

            <LazyRoute
              path="/dailyalgo"
              load={() => import("./pages/DailyAlgo.svelte")}
            />
            <LazyRoute
              path="/members/*"
              load={() => import("./pages/Members.svelte")}
            />
            <LazyRoute
              path="/recruitment"
              load={() => import("./pages/Recruitment.svelte")}
            />
            <LazyRoute
              path="/forms"
              load={() => import("./pages/CustomForms.svelte")}
            />
            <LazyRoute
              path="/forms/builder/new"
              load={() => import("./pages/FormBuilder.svelte")}
              props={() => ({ formId: null })}
            />
            <LazyRoute
              path="/forms/builder/:formId"
              load={() => import("./pages/FormBuilder.svelte")}
              props={(meta) => ({ formId: meta.params.formId })}
            />
            <LazyRoute
              path="/forms/:formId/responses"
              load={() => import("./pages/CustomFormResponses.svelte")}
              props={(meta) => ({ formId: meta.params.formId })}
            />
            <LazyRoute
              path="/tickets"
              load={() => import("./pages/Tickets.svelte")}
            />
            <LazyRoute
              path="/transcripts-list"
              load={() => import("./pages/Transcripts.svelte")}
            />
            <LazyRoute
              path="/message-search"
              load={() => import("./pages/MessageSearch.svelte")}
            />
            <LazyRoute
              path="/meetings"
              load={() => import("./pages/Meetings.svelte")}
            />
            <Route path="/absences">
              <div use:navigate={"/planning"}></div>
            </Route>
            <LazyRoute
              path="/planning/*"
              load={() => import("./pages/Planning.svelte")}
            />
            <LazyRoute
              path="/inbox/*"
              load={() => import("./pages/Inbox.svelte")}
            />
            <LazyRoute
              path="/tutoring"
              load={() => import("./pages/Tutoring.svelte")}
            />
            <LazyRoute
              path="/nickname-moderation/*"
              load={() => import("./pages/NicknameModeration.svelte")}
            />

            <LazyRoute
              path="/leveling/*"
              load={() => import("./pages/Leveling.svelte")}
            />
            <LazyRoute
              path="/economy/*"
              load={() => import("./pages/Economy.svelte")}
            />
            <LazyRoute
              path="/giveaways"
              load={() => import("./pages/Giveaways.svelte")}
            />
            <LazyRoute
              path="/welcome/*"
              load={() => import("./pages/Announcement.svelte")}
            />
            <LazyRoute
              path="/announcement/*"
              load={() => import("./pages/Announcement.svelte")}
            />
            <LazyRoute
              path="/reaction-roles"
              load={() => import("./pages/ReactionRoles.svelte")}
            />
            <LazyRoute
              path="/triggers"
              load={() => import("./pages/Triggers.svelte")}
            />
            <LazyRoute
              path="/automod"
              load={() => import("./pages/AutoMod.svelte")}
            />
            <LazyRoute
              path="/raid-protection"
              load={() => import("./pages/RaidProtection.svelte")}
            />
            <LazyRoute
              path="/suggestions"
              load={() => import("./pages/Suggestions.svelte")}
            />
            <LazyRoute
              path="/embed-builder"
              load={() => import("./pages/EmbedBuilder.svelte")}
            />
            <LazyRoute
              path="/fun"
              load={() => import("./pages/FunSettings.svelte")}
            />
            <LazyRoute
              path="/clans"
              load={() => import("./pages/Clans.svelte")}
            />

            <LazyRoute
              path="/double-accounts/*"
              load={() => import("./pages/DoubleAccounts.svelte")}
            />
            <LazyRoute
              path="/invitations/:code"
              load={() => import("./pages/InvitationDetail.svelte")}
              props={(meta) => ({ code: meta.params.code })}
              remountKey={(meta) => meta.params.code}
            />
            <LazyRoute
              path="/invitations/*"
              load={() => import("./pages/Invitations.svelte")}
            />

            <LazyRoute
              path="/events"
              load={() => import("./pages/Events.svelte")}
            />
            <LazyRoute
              path="/events/edit/:eventId"
              load={() => import("./pages/EventEditor.svelte")}
              props={(meta) => ({ eventId: meta.params.eventId })}
            />
            <LazyRoute
              path="/events/control/:eventId"
              load={() => import("./pages/EventControl.svelte")}
              props={(meta) => ({ eventId: meta.params.eventId })}
            />

            <LazyRoute
              path="/userSettings"
              load={() => import("./pages/UserSettings.svelte")}
            />

            <!-- Fallback for authenticated users -->
            <Route fallback>
              <NotFound />
            </Route>
          </MainLayout>
        {/if}
      {:else if $router.path !== "/login"}
        <!-- Fallback for unauthenticated users -->
        <Route path="/*">
          <div class="flex items-center justify-center min-h-screen">
            <div
              class="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"
            ></div>
          </div>
        </Route>
      {/if}
    {/if}

    {#snippet failed(error)}
      <GlobalErrorOverlay
        errorMsg={error instanceof Error ? error.message : String(error)}
        errorStack={error instanceof Error ? error.stack : undefined}
      />
    {/snippet}
  </svelte:boundary>
{/if}

<ToastContainer />
<GlobalConfirmDialog />
<CommandPalette />

{#if inviteDetailsModal.open}
  {#await import("./lib/components/invitations/InviteDetailsModal.svelte") then module}
    {@const InviteDetailsModal = module.default}
    <InviteDetailsModal />
  {/await}
{/if}

{#if feedbackModal.open}
  {#await import("./lib/components/FeedbackModal.svelte") then module}
    {@const FeedbackModal = module.default}
    <FeedbackModal />
  {/await}
{/if}

{#if showKeyboardShortcuts}
  {#await import("./lib/components/KeyboardShortcutsModal.svelte") then module}
    {@const KeyboardShortcutsModal = module.default}
    <KeyboardShortcutsModal
      isOpen={showKeyboardShortcuts}
      onClose={() => showKeyboardShortcuts = false}
    />
  {/await}
{/if}
