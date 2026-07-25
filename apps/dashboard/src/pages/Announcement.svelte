<script lang="ts">
  import { m } from '../lib/i18n';
  import { channelDisplayName } from '../lib/channelUtils';
  import { onMount, onDestroy, untrack } from 'svelte';
  import { router } from 'tinro';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import SearchableSelect from '../lib/components/SearchableSelect.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import LoadingHint from '../lib/components/LoadingHint.svelte';
  import ActionButton from '../lib/components/ActionButton.svelte';
  import EmojiPicker from '../lib/components/EmojiPicker.svelte';
  import {
    fetchWelcomeConfig,
    updateWelcomeConfig,
    fetchWelcomeThreadConfig,
    updateWelcomeThreadConfig,
    updateWelcomeThreadSteps,
    updateWelcomeThreadPages,
  } from '../lib/api';

  const actionState = createAsyncActionState();
  let loading = $state(false);

  const welcomePresets = [
    { label: m.e2_preset_welcome_classic(),   icon: 'DoorOpen', text: 'Bienvenue {user} sur **{server}** ! 🎉 Tu es notre **{memberCount}**ème membre !' },
    { label: m.e2_preset_welcome_festive(),      icon: 'Sparkles', text: '🎊 Hourra ! {user} vient de rejoindre **{server}** ! Bienvenue parmi nous, tu es le membre **#{memberCount}** !' },
    { label: m.e2_preset_welcome_immersive(),    icon: 'Shield',   text: '⚔️ Un nouveau guerrier débarque ! Bienvenue {user} sur **{server}** ! Prépare-toi à rejoindre l\'aventure !' },
    { label: m.e2_preset_welcome_warm(),  icon: 'Users',    text: 'Hey {user} ! 👋 Toute l\'équipe de **{server}** est ravie de t\'accueillir. N\'hésite pas à te présenter !' },
    { label: m.e2_preset_welcome_gaming(),      icon: 'Gamepad2', text: 'GG {user} ! Tu viens de rejoindre **{server}** 🎮 – le serveur ultime. Amuse-toi bien et bonne chance !' },
  ];

  const leavePresets = [
    { label: m.e2_preset_leave_simple(),       icon: 'Logout',   text: '{username} vient de quitter **{server}**. 👋 On espère te revoir bientôt !' },
    { label: m.e2_preset_leave_sad(),       icon: 'Frown',    text: 'Oh non... {username} a quitté le navire. 😢 Nous sommes maintenant **{memberCount}** membres.' },
    { label: m.e2_preset_leave_neutral(),       icon: 'Smile',    text: '{username} a quitté **{server}**. Il nous reste **{memberCount}** membres.' },
    { label: m.e2_preset_leave_poetic(),     icon: 'Cloud',    text: 'Et comme une vague, {username} s\'en est allé... ✨ On ne l\'oubliera pas.' },
    { label: m.e2_preset_leave_dramatic(),   icon: 'Play',     text: '🎬 Rideau. {username} a quitté **{server}** pour de nouvelles aventures. Bon courage !' },
  ];

  const boostPresets = [
    { label: m.e2_preset_boost_standard(),      icon: 'Zap',      text: 'Merci {user} pour ton boost ! 🚀 Grâce à toi, **{server}** compte maintenant **{boostCount}** boosts !' },
    { label: m.e2_preset_boost_premium(),       icon: 'Gem',      text: '💎 WOW ! {user} vient de booster **{server}** ! Tu es incroyable, merci énormément ! 🙏' },
    { label: m.e2_preset_boost_epic(),      icon: 'Zap',      text: '⚡ BOOST ACTIVÉ ! {user} propulse **{server}** vers de nouveaux sommets ! On est à **{boostCount}** boosts !' },
    { label: m.e2_preset_boost_festive(),      icon: 'Sparkles', text: '🎉 {user} a boosté le serveur ! Merci pour ton soutien, tu es une star ! ✨ ({boostCount} boosts au total)' },
    { label: m.e2_preset_boost_heroic(),   icon: 'Trophy',   text: '🏆 Héros du jour : {user} ! Son boost porte **{server}** à **{boostCount}** boosts. Respect total !' },
  ];

  let showWelcomePresets = $state(false);
  let showLeavePresets   = $state(false);
  let showBoostPresets   = $state(false);
  const announcementTabs = ['welcome', 'leave', 'boost', 'autoroles', 'thread'] as const;
  type AnnouncementTab = typeof announcementTabs[number];
  const ANNOUNCE_BASE = window.location.pathname.startsWith('/welcome') ? '/welcome' : '/announcement';
  let activeTab = $state<AnnouncementTab>('welcome');

  $effect(() => {
    const _path = $router.path;
    activeTab = resolveTabFromUrl(ANNOUNCE_BASE, announcementTabs, 'welcome') as AnnouncementTab;
  });

  const canManageSettings = $derived(
    !!dashboardStore.state.featureAccess?.welcome_goodbye?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
  );

  const availableChannels = $derived(dashboardStore.state.discordChannels || []);
  const availableRoles = $derived(dashboardStore.state.discordRoles || []);

  let config = $state({
    welcomeEnabled: false,
    welcomeChannelId: null as string | null,
    welcomeMessage: 'Bienvenue {user} sur notre serveur ! 🎉',
    welcomeImageEnabled: false,
    welcomeImageUrl: null as string | null,
    leaveEnabled: false,
    leaveChannelId: null as string | null,
    leaveMessage: 'Au revoir {user}... 😢',
    boostEnabled: false,
    boostChannelId: null as string | null,
    boostMessage: 'Merci pour ton boost {user} ! 🚀',
    boostImageEnabled: false,
    boostImageUrl: null as string | null,
    joinRoleId: null as string | null,
    tagAutoRoleEnabled: false,
    tagAutoRoleWord: '',
    tagAutoRoleId: null as string | null,
  });

  // Snapshot of last-saved state
  let savedConfig = $state({
    welcomeEnabled: false,
    welcomeChannelId: null as string | null,
    welcomeMessage: 'Bienvenue {user} sur notre serveur ! 🎉',
    welcomeImageEnabled: false,
    welcomeImageUrl: null as string | null,
    leaveEnabled: false,
    leaveChannelId: null as string | null,
    leaveMessage: 'Au revoir {user}... 😢',
    boostEnabled: false,
    boostChannelId: null as string | null,
    boostMessage: 'Merci pour ton boost {user} ! 🚀',
    boostImageEnabled: false,
    boostImageUrl: null as string | null,
    joinRoleId: null as string | null,
    tagAutoRoleEnabled: false,
    tagAutoRoleWord: '',
    tagAutoRoleId: null as string | null,
  });

  $effect(() => {
    const dirty = JSON.stringify(config) !== JSON.stringify(savedConfig);
    if (dirty && canManageSettings) {
      untrack(() => {
        unsavedChanges.register({
          label: 'Annonces & Auto-Rôle',
          onSave: () => handleSave(),
          onReset: () => { config = { ...savedConfig }; }
        });
      });
    } else if (!dirty) {
      untrack(() => {
        if (unsavedChanges.isDirty && unsavedChanges.pageLabel === 'Annonces & Auto-Rôle') {
          unsavedChanges.clear();
        }
      });
    }
  });

  onDestroy(() => {
    if (unsavedChanges.pageLabel === 'Annonces & Auto-Rôle') unsavedChanges.clear();
  });

  onMount(async () => {
    loading = true;
    try {
      await dashboardStore.refresh();
      const res = await fetchWelcomeConfig();
      if (res && res.config) {
        config = {
          welcomeEnabled: res.config.welcomeEnabled ?? false,
          welcomeChannelId: res.config.welcomeChannelId ?? null,
          welcomeMessage: res.config.welcomeMessage ?? '',
          welcomeImageEnabled: res.config.welcomeImageEnabled ?? false,
          welcomeImageUrl: res.config.welcomeImageUrl ?? null,
          leaveEnabled: res.config.leaveEnabled ?? false,
          leaveChannelId: res.config.leaveChannelId ?? null,
          leaveMessage: res.config.leaveMessage ?? '',
          boostEnabled: res.config.boostEnabled ?? false,
          boostChannelId: res.config.boostChannelId ?? null,
          boostMessage: res.config.boostMessage ?? '',
          boostImageEnabled: res.config.boostImageEnabled ?? false,
          boostImageUrl: res.config.boostImageUrl ?? null,
          joinRoleId: res.config.joinRoleId ?? null,
          tagAutoRoleEnabled: res.config.tagAutoRoleEnabled ?? false,
          tagAutoRoleWord: res.config.tagAutoRoleWord ?? '',
          tagAutoRoleId: res.config.tagAutoRoleId ?? null,
        };
        savedConfig = { ...config };
      }
    } catch (err) {
      console.error(err);
    } finally {
      loading = false;
    }
  });

  async function handleSave(): Promise<boolean> {
    if (!canManageSettings) return false;
    let success = false;
    await actionState.run(async () => {
      const res = await updateWelcomeConfig(config);
      if (!res) throw new Error('Erreur de sauvegarde');
      const saved = {
        welcomeEnabled: res.config.welcomeEnabled ?? false,
        welcomeChannelId: res.config.welcomeChannelId ?? null,
        welcomeMessage: res.config.welcomeMessage ?? '',
        welcomeImageEnabled: res.config.welcomeImageEnabled ?? false,
        welcomeImageUrl: res.config.welcomeImageUrl ?? null,
        leaveEnabled: res.config.leaveEnabled ?? false,
        leaveChannelId: res.config.leaveChannelId ?? null,
        leaveMessage: res.config.leaveMessage ?? '',
        boostEnabled: res.config.boostEnabled ?? false,
        boostChannelId: res.config.boostChannelId ?? null,
        boostMessage: res.config.boostMessage ?? '',
        boostImageEnabled: res.config.boostImageEnabled ?? false,
        boostImageUrl: res.config.boostImageUrl ?? null,
        joinRoleId: res.config.joinRoleId ?? null,
        tagAutoRoleEnabled: res.config.tagAutoRoleEnabled ?? false,
        tagAutoRoleWord: res.config.tagAutoRoleWord ?? '',
        tagAutoRoleId: res.config.tagAutoRoleId ?? null,
      };
      config = saved;
      savedConfig = { ...saved };
      success = true;
      return true;
    }, { successMessage: 'Configuration enregistrée avec succès !' });
    return success;
  }

  // Preview helper
  function previewText(template: string) {
    return template
      .replace(/{user}/g, '@JeanDupont')
      .replace(/{username}/g, 'JeanDupont')
      .replace(/{displayName}/g, 'JeanDupont')
      .replace(/{server}/g, 'Kotbo Server')
      .replace(/{memberCount}/g, '1,234')
      .replace(/{boostCount}/g, '18');
  }

  // ── Thread d'accueil (welcome-thread) ──────────────────────────
  type ThreadStep = { localId: string; content: string; name: string | null; avatarUrl: string | null; delayMs: number };
  type MenuPage = {
    localId: string;
    label: string;
    emoji: string;
    summary: string | null;
    actionType: 'EMBED' | 'ROLE' | 'LINK';
    roleId: string | null;
    roleAction: 'ADD' | 'REMOVE' | 'TOGGLE' | 'EXCLUSIVE';
    roleGroup: string | null;
    linkMode: 'channel' | 'url';
    linkChannelId: string | null;
    linkUrl: string | null;
    embedTitle: string;
    embedDescription: string;
    embedColor: string;
    embedImageUrl: string | null;
    embedThumbnailUrl: string | null;
  };

  function discordChannelLink(channelId: string): string {
    return `https://discord.com/channels/${authStore.selectedGuildId}/${channelId}`;
  }

  function parseChannelLink(url: string | null | undefined): string | null {
    if (!url) return null;
    const prefix = `https://discord.com/channels/${authStore.selectedGuildId}/`;
    return url.startsWith(prefix) ? url.slice(prefix.length) : null;
  }

  const MAX_THREAD_STEPS = 20;
  const MAX_MENU_PAGES = 25;

  const autoArchiveOptions = [
    { value: 60, label: '1 heure' },
    { value: 1440, label: '24 heures' },
    { value: 4320, label: '3 jours' },
    { value: 10080, label: '7 jours' },
  ];

  const threadActionState = createAsyncActionState();
  let threadLoading = $state(false);
  let localIdCounter = 0;
  function nextLocalId(prefix: string) {
    localIdCounter += 1;
    return `${prefix}-${Date.now()}-${localIdCounter}`;
  }

  function defaultThreadConfig() {
    return {
      enabled: false,
      channelId: null as string | null,
      threadNameTemplate: '👋 Bienvenue {username} !',
      threadMode: 'public' as 'public' | 'private',
      autoArchiveMinutes: 1440,
      typingEnabled: true,
      webhookName: 'Kotbo',
      webhookAvatarUrl: null as string | null,
      menuEnabled: true,
      menuStyle: 'buttons' as 'buttons' | 'select',
      menuPlaceholder: 'Découvrir le serveur...',
      embedTitle: 'Bienvenue sur {server} !',
      embedDescription: "Explore les sections ci-dessous pour découvrir le serveur. 👇",
      embedColor: '#5865F2',
      embedImageUrl: null as string | null,
      embedThumbnailUrl: null as string | null,
    };
  }

  function mapThreadConfig(raw: any) {
    const d = defaultThreadConfig();
    return {
      enabled: raw?.enabled ?? d.enabled,
      channelId: raw?.channelId ?? d.channelId,
      threadNameTemplate: raw?.threadNameTemplate ?? d.threadNameTemplate,
      threadMode: raw?.threadMode ?? d.threadMode,
      autoArchiveMinutes: raw?.autoArchiveMinutes ?? d.autoArchiveMinutes,
      typingEnabled: raw?.typingEnabled ?? d.typingEnabled,
      webhookName: raw?.webhookName ?? d.webhookName,
      webhookAvatarUrl: raw?.webhookAvatarUrl ?? d.webhookAvatarUrl,
      menuEnabled: raw?.menuEnabled ?? d.menuEnabled,
      menuStyle: raw?.menuStyle ?? d.menuStyle,
      menuPlaceholder: raw?.menuPlaceholder ?? d.menuPlaceholder,
      embedTitle: raw?.embedTitle ?? d.embedTitle,
      embedDescription: raw?.embedDescription ?? d.embedDescription,
      embedColor: raw?.embedColor ?? d.embedColor,
      embedImageUrl: raw?.embedImageUrl ?? d.embedImageUrl,
      embedThumbnailUrl: raw?.embedThumbnailUrl ?? d.embedThumbnailUrl,
    };
  }

  function mapThreadSteps(raw: any[] | undefined): ThreadStep[] {
    return (raw || []).map((s) => ({
      localId: s.id ?? nextLocalId('step'),
      content: s.content ?? '',
      name: s.name ?? null,
      avatarUrl: s.avatarUrl ?? null,
      delayMs: s.delayMs ?? 3000,
    }));
  }

  function mapThreadPages(raw: any[] | undefined): MenuPage[] {
    return (raw || []).map((p) => {
      const linkUrl: string | null = p.linkUrl ?? null;
      const linkChannelId = parseChannelLink(linkUrl);
      return {
        localId: p.id ?? nextLocalId('page'),
        label: p.label ?? '',
        emoji: p.emoji ?? '',
        summary: p.summary ?? null,
        actionType: (p.actionType === 'ROLE' || p.actionType === 'LINK') ? p.actionType : 'EMBED',
        roleId: p.roleId ?? null,
        roleAction: (p.roleAction === 'REMOVE' || p.roleAction === 'TOGGLE' || p.roleAction === 'EXCLUSIVE') ? p.roleAction : 'ADD',
        roleGroup: p.roleGroup ?? null,
        linkMode: linkChannelId ? 'channel' : 'url',
        linkChannelId,
        linkUrl,
        embedTitle: p.embedTitle ?? '',
        embedDescription: p.embedDescription ?? '',
        embedColor: p.embedColor ?? '#5865F2',
        embedImageUrl: p.embedImageUrl ?? null,
        embedThumbnailUrl: p.embedThumbnailUrl ?? null,
      };
    });
  }

  function moveItem<T>(arr: T[], index: number, offset: number): T[] {
    const target = index + offset;
    if (target < 0 || target >= arr.length) return arr;
    const next = [...arr];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    return next;
  }

  let threadConfig = $state(defaultThreadConfig());
  let savedThreadConfig = $state(defaultThreadConfig());
  let threadSteps = $state<ThreadStep[]>([]);
  let savedThreadSteps = $state<ThreadStep[]>([]);
  let threadPages = $state<MenuPage[]>([]);
  let savedThreadPages = $state<MenuPage[]>([]);

  const threadConfigDirty = $derived(JSON.stringify(threadConfig) !== JSON.stringify(savedThreadConfig));
  const threadStepsDirty = $derived(JSON.stringify(threadSteps) !== JSON.stringify(savedThreadSteps));
  const threadPagesDirty = $derived(JSON.stringify(threadPages) !== JSON.stringify(savedThreadPages));

  onMount(async () => {
    threadLoading = true;
    try {
      const res = await fetchWelcomeThreadConfig();
      if (res && res.config) {
        const mappedConfig = mapThreadConfig(res.config);
        threadConfig = mappedConfig;
        savedThreadConfig = { ...mappedConfig };

        const mappedSteps = mapThreadSteps(res.config.steps);
        threadSteps = mappedSteps;
        savedThreadSteps = mappedSteps.map((s) => ({ ...s }));

        const mappedPages = mapThreadPages(res.config.pages);
        threadPages = mappedPages;
        savedThreadPages = mappedPages.map((p) => ({ ...p }));
      }
    } catch (err) {
      console.error(err);
    } finally {
      threadLoading = false;
    }
  });

  async function saveThreadConfig(): Promise<boolean> {
    if (!canManageSettings) return false;
    let success = false;
    await threadActionState.run(async () => {
      const res = await updateWelcomeThreadConfig(threadConfig);
      if (!res || !res.config) throw new Error('Erreur de sauvegarde');
      const saved = mapThreadConfig(res.config);
      threadConfig = saved;
      savedThreadConfig = { ...saved };
      success = true;
      return true;
    }, { successMessage: "Configuration du thread d'accueil enregistrée !" });
    return success;
  }

  function addStep() {
    if (!canManageSettings || threadSteps.length >= MAX_THREAD_STEPS) return;
    threadSteps = [...threadSteps, { localId: nextLocalId('step'), content: '', name: null, avatarUrl: null, delayMs: 3000 }];
  }

  function removeStep(index: number) {
    threadSteps = threadSteps.filter((_, i) => i !== index);
  }

  function moveStep(index: number, offset: number) {
    threadSteps = moveItem(threadSteps, index, offset);
  }

  async function saveThreadSteps(): Promise<boolean> {
    if (!canManageSettings) return false;
    let success = false;
    await threadActionState.run(async () => {
      if (threadSteps.some((s) => !s.content.trim())) {
        throw new Error('Chaque message de la séquence doit avoir un contenu.');
      }
      const res = await updateWelcomeThreadSteps(threadSteps.map((s) => ({
        content: s.content.trim(),
        name: s.name?.trim() || null,
        avatarUrl: s.avatarUrl?.trim() || null,
        delayMs: s.delayMs,
      })));
      if (!res || !res.config) throw new Error('Erreur de sauvegarde');
      const mapped = mapThreadSteps(res.config.steps);
      threadSteps = mapped;
      savedThreadSteps = mapped.map((s) => ({ ...s }));
      success = true;
      return true;
    }, { successMessage: 'Séquence de messages enregistrée !' });
    return success;
  }

  function addPage() {
    if (!canManageSettings || threadPages.length >= MAX_MENU_PAGES) return;
    threadPages = [...threadPages, {
      localId: nextLocalId('page'),
      label: '',
      emoji: '',
      summary: null,
      actionType: 'EMBED',
      roleId: null,
      roleAction: 'ADD',
      roleGroup: null,
      linkMode: 'channel',
      linkChannelId: null,
      linkUrl: null,
      embedTitle: '',
      embedDescription: '',
      embedColor: '#5865F2',
      embedImageUrl: null,
      embedThumbnailUrl: null,
    }];
  }

  function removePage(index: number) {
    threadPages = threadPages.filter((_, i) => i !== index);
  }

  function movePage(index: number, offset: number) {
    threadPages = moveItem(threadPages, index, offset);
  }

  function resolvePageLinkUrl(p: MenuPage): string | null {
    if (p.linkMode === 'channel') {
      return p.linkChannelId ? discordChannelLink(p.linkChannelId) : null;
    }
    return p.linkUrl?.trim() || null;
  }

  function normalizeRoleGroupName(value: string | null | undefined): string {
    return value?.trim().replace(/\s+/g, ' ') || '';
  }

  function exclusiveGroupNames(currentPage: MenuPage): string[] {
    const names = new Map<string, string>();
    for (const page of threadPages) {
      if (page === currentPage || page.roleAction !== 'EXCLUSIVE') continue;
      const label = normalizeRoleGroupName(page.roleGroup);
      if (label) names.set(label.toLocaleLowerCase('fr-FR'), label);
    }
    return [...names.values()].sort((a, b) => a.localeCompare(b, 'fr'));
  }

  function exclusiveGroupMembers(currentPage: MenuPage): MenuPage[] {
    const groupKey = normalizeRoleGroupName(currentPage.roleGroup).toLocaleLowerCase('fr-FR');
    if (!groupKey) return [];
    return threadPages.filter((page) =>
      page.actionType === 'ROLE'
      && page.roleAction === 'EXCLUSIVE'
      && normalizeRoleGroupName(page.roleGroup).toLocaleLowerCase('fr-FR') === groupKey
    );
  }

  async function saveThreadPages(): Promise<boolean> {
    if (!canManageSettings) return false;
    let success = false;
    await threadActionState.run(async () => {
      const exclusiveGroups = new Map<string, Set<string>>();
      for (const p of threadPages) {
        if (!p.label.trim()) throw new Error('Chaque page doit avoir un label.');
        if (p.actionType === 'EMBED' && (!p.embedTitle.trim() || !p.embedDescription.trim())) {
          throw new Error('Les pages de type Embed doivent avoir un titre et une description.');
        }
        if (p.actionType === 'ROLE' && !p.roleId) {
          throw new Error('Les pages de type Rôle doivent avoir un rôle sélectionné.');
        }
        if (p.actionType === 'ROLE' && p.roleAction === 'EXCLUSIVE') {
          const groupLabel = normalizeRoleGroupName(p.roleGroup);
          if (!groupLabel) throw new Error('Chaque choix exclusif doit appartenir à un groupe.');
          const groupKey = groupLabel.toLocaleLowerCase('fr-FR');
          const roleIds = exclusiveGroups.get(groupKey) ?? new Set<string>();
          roleIds.add(p.roleId!);
          exclusiveGroups.set(groupKey, roleIds);
        }
        if (p.actionType === 'LINK' && !resolvePageLinkUrl(p)) {
          throw new Error('Les pages de type Lien doivent avoir un salon ou une URL.');
        }
      }
      for (const [groupName, roleIds] of exclusiveGroups) {
        if (roleIds.size < 2) {
          throw new Error(`Le groupe exclusif « ${groupName} » doit contenir au moins deux rôles différents.`);
        }
      }

      const res = await updateWelcomeThreadPages(threadPages.map((p) => ({
        label: p.label.trim(),
        emoji: p.emoji.trim() || null,
        summary: p.summary?.trim() || null,
        actionType: p.actionType,
        roleId: p.actionType === 'ROLE' ? p.roleId : null,
        roleAction: p.roleAction,
        roleGroup: p.actionType === 'ROLE' && p.roleAction === 'EXCLUSIVE' ? normalizeRoleGroupName(p.roleGroup) : null,
        linkUrl: p.actionType === 'LINK' ? resolvePageLinkUrl(p) : null,
        embedTitle: p.embedTitle.trim(),
        embedDescription: p.embedDescription.trim(),
        embedColor: p.embedColor,
        embedImageUrl: p.embedImageUrl?.trim() || null,
        embedThumbnailUrl: p.embedThumbnailUrl?.trim() || null,
      })));
      if (!res || !res.config) throw new Error('Erreur de sauvegarde');
      const mapped = mapThreadPages(res.config.pages);
      threadPages = mapped;
      savedThreadPages = mapped.map((p) => ({ ...p }));
      success = true;
      return true;
    }, { successMessage: 'Pages de présentation enregistrées !' });
    return success;
  }
</script>

<ModulePage
  title="Annonces & Auto-Rôle"
  description="Gérez les messages de bienvenue, départ, boosts Discord et les attributions automatiques de rôles."
  icon="megaphone"
  featureKey="welcome_goodbye"
>
  <InlineFeedback state={actionState} />

  {#if loading}
    <div class="space-y-6">
      <Skeleton height="60px" radius="1.5rem" />
      <Skeleton height="450px" radius="2.5rem" />
    </div>
    <div class="flex justify-center mt-4">
      <LoadingHint context="config" />
    </div>
  {:else}
    <!-- Tabs Header -->
    <div class="tab-group w-fit">
      <button
        onclick={() => gotoTab(ANNOUNCE_BASE, 'welcome', 'welcome')}
        class="tab-button {activeTab === 'welcome' ? 'active' : ''}"
      >
        <Papicon icon="DoorOpen" size={14} />
        Accueil
      </button>
      <button
        onclick={() => gotoTab(ANNOUNCE_BASE, 'leave', 'welcome')}
        class="tab-button {activeTab === 'leave' ? 'active' : ''}"
      >
        <Papicon icon="Logout" size={14} />
        Départ
      </button>
      <button
        onclick={() => gotoTab(ANNOUNCE_BASE, 'boost', 'welcome')}
        class="tab-button {activeTab === 'boost' ? 'active' : ''}"
      >
        <Papicon icon="Zap" size={14} />
        Boosts
      </button>
      <button
        onclick={() => gotoTab(ANNOUNCE_BASE, 'autoroles', 'welcome')}
        class="tab-button {activeTab === 'autoroles' ? 'active' : ''}"
      >
        <Papicon icon="Shield" size={14} />
        Auto-Rôles
      </button>
      <button
        onclick={() => gotoTab(ANNOUNCE_BASE, 'thread', 'welcome')}
        class="tab-button {activeTab === 'thread' ? 'active' : ''}"
      >
        <Papicon icon="chat" size={14} />
        Thread d'accueil
      </button>
    </div>

    <!-- Guides Box (Contextual) -->
    <section class="bg-surface-container-low/30 border border-outline-variant/10 p-6 rounded-xl space-y-2">
      <h4 class="text-sm font-bold text-on-surface flex items-center gap-2">
        <Papicon icon="Info" size={16} class="text-primary" />
        {#if activeTab === 'autoroles'}
          Règles de configuration des Auto-Rôles
        {:else}
          Guide des variables éligibles
        {/if}
      </h4>
      {#if activeTab === 'autoroles'}
        <p class="text-xs text-on-surface-variant/80 font-medium">
          L'attribution automatique donne des rôles configurés aux membres. L'auto-rôle à l'arrivée s'applique immédiatement à l'entrée. L'auto-rôle tag s'applique et se retire automatiquement lorsque le membre met à jour son pseudo ou pseudo global avec le tag recherché.
        </p>
      {:else}
        <p class="text-xs text-on-surface-variant/80 font-medium">
          Vous pouvez insérer les balises suivantes dans vos templates de messages pour les personnaliser dynamiquement :
        </p>
        <div class="flex flex-wrap gap-3 pt-2">
          <span class="text-[11px] font-mono bg-surface-container-high px-2.5 py-1.5 rounded-xl border border-outline-variant/10 font-bold"><code class="text-primary dark:text-blue-300">{`{user}`}</code> : Mentionne le membre</span>
          <span class="text-[11px] font-mono bg-surface-container-high px-2.5 py-1.5 rounded-xl border border-outline-variant/10 font-bold"><code class="text-primary dark:text-blue-300">{`{username}`}</code> : Nom du membre</span>
          <span class="text-[11px] font-mono bg-surface-container-high px-2.5 py-1.5 rounded-xl border border-outline-variant/10 font-bold"><code class="text-primary dark:text-blue-300">{`{server}`}</code> : Nom du serveur</span>
          {#if activeTab === 'thread'}
            <span class="text-[11px] font-mono bg-surface-container-high px-2.5 py-1.5 rounded-xl border border-outline-variant/10 font-bold"><code class="text-primary dark:text-blue-300">{`{displayName}`}</code> : Pseudo affiché sur le serveur</span>
          {:else}
            <span class="text-[11px] font-mono bg-surface-container-high px-2.5 py-1.5 rounded-xl border border-outline-variant/10 font-bold"><code class="text-primary dark:text-blue-300">{`{memberCount}`}</code> : Nombre total de membres</span>
          {/if}
          {#if activeTab === 'boost'}
            <span class="text-[11px] font-mono bg-surface-container-high px-2.5 py-1.5 rounded-xl border border-outline-variant/10 font-bold"><code class="text-primary dark:text-blue-300">{`{boostCount}`}</code> : Nombre de boosts actuel</span>
          {/if}
        </div>
      {/if}
    </section>

    <!-- Tab Contents -->
    <div class="space-y-6">
      
      <!-- Welcome Tab -->
      {#if activeTab === 'welcome'}
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6 max-w-4xl">
          <div class="flex items-center justify-between border-b border-outline-variant/15 pb-4">
            <h3 class="text-xl font-semibold flex items-center gap-3">
              <Papicon icon="DoorOpen" size={20} class="text-primary" />
              Message de Bienvenue
            </h3>
            <ToggleSwitch 
              checked={config.welcomeEnabled} 
              onToggle={(v: boolean) => config.welcomeEnabled = v} 
              disabled={!canManageSettings}
            />
          </div>

          {#if config.welcomeEnabled}
            <div class="space-y-4 animate-in fade-in duration-300">
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div class="space-y-1.5">
                  <label for="wChannel" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Salon de diffusion</label>
                  <SearchableSelect 
                    id="wChannel"
                    bind:value={config.welcomeChannelId} 
                    options={availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))} 
                    placeholder="Sélectionner le salon" 
                    className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all"
                    disabled={!canManageSettings}
                  />
                </div>
              </div>

              <div class="space-y-1.5">
                <div class="flex items-center justify-between ml-2 mb-1">
                  <label for="wMsg" class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest">Contenu du message</label>
                  <button
                    onclick={() => showWelcomePresets = !showWelcomePresets}
                    class="text-[10px] font-bold text-primary/70 hover:text-primary flex items-center gap-1.5 transition-colors"
                    disabled={!canManageSettings}
                  >
                    <Papicon icon="Sparkles" size={12} />
                    <span>Presets</span>
                    <span class="transition-transform duration-200 {showWelcomePresets ? 'rotate-180' : ''}">▾</span>
                  </button>
                </div>
                {#if showWelcomePresets}
                  <div class="flex flex-wrap gap-2 pb-2 animate-in fade-in duration-200">
                    {#each welcomePresets as preset}
                      <button
                        onclick={() => { config.welcomeMessage = preset.text; showWelcomePresets = false; }}
                        class="text-[10px] font-bold px-3 py-1.5 rounded-xl border border-primary/20 bg-primary/5 hover:bg-primary/15 text-primary transition-all hover: flex items-center gap-1.5"
                        disabled={!canManageSettings}
                      >
                        <Papicon icon={preset.icon} size={12} />
                        {preset.label}
                      </button>
                    {/each}
                  </div>
                {/if}
                <textarea 
                  id="wMsg"
                  bind:value={config.welcomeMessage} 
                  class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none h-28 resize-none"
                  placeholder="Écrivez le message de bienvenue..."
                  disabled={!canManageSettings}
                ></textarea>
              </div>

              <div class="p-4 rounded-lg bg-surface-container-high/20 border border-outline-variant/5 space-y-3">
                <div class="flex items-center justify-between">
                  <div>
                    <p class="text-sm font-bold">Activer l'image de bienvenue</p>
                    <p class="text-[10px] text-on-surface-variant/50">Génère un bandeau d'avatar stylisé</p>
                  </div>
                  <ToggleSwitch 
                    checked={config.welcomeImageEnabled} 
                    onToggle={(v: boolean) => config.welcomeImageEnabled = v} 
                    disabled={!canManageSettings}
                  />
                </div>

                {#if config.welcomeImageEnabled}
                  <div class="space-y-1.5 pt-2 animate-in fade-in duration-300">
                    <label for="wImgUrl" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">URL de fond d'image personnalisée (Optionnel)</label>
                    <input 
                      id="wImgUrl"
                      type="url" 
                      bind:value={config.welcomeImageUrl} 
                      placeholder="https://example.com/background.png"
                      class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
                      disabled={!canManageSettings}
                    />
                  </div>
                {/if}
              </div>

              <div class="space-y-1.5">
                <span class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Aperçu du rendu Discord</span>
                <div class="p-5 rounded-lg bg-surface-container-high/35 border border-outline-variant/15 text-sm text-on-surface font-semibold font-sans whitespace-pre-wrap select-none relative overflow-hidden">
                  <div class="flex items-start gap-4">
                    <div class="w-10 h-10 rounded-full bg-outline-variant/30 flex items-center justify-center text-xs font-semibold text-on-surface-variant/60">BOT</div>
                    <div>
                      <div class="flex items-center gap-2">
                        <span class="font-bold text-primary">Kotbo</span>
                        <span class="bg-primary/20 text-primary text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase leading-none">BOT</span>
                        <span class="text-[11px] text-on-surface-variant/40">Aujourd'hui à 12:00</span>
                      </div>
                      <div class="mt-1 text-on-surface-variant/90 leading-relaxed text-sm font-medium font-sans">
                        {previewText(config.welcomeMessage)}
                      </div>
                      {#if config.welcomeImageEnabled}
                        <div class="mt-3 w-full max-w-sm aspect-5/2 rounded-xl bg-[#0b0e14] flex items-center justify-center border border-[#5865f2]/30 relative overflow-hidden">
                          {#if config.welcomeImageUrl}
                            <img src={config.welcomeImageUrl} alt="Background" class="absolute inset-0 w-full h-full object-cover opacity-50" />
                          {/if}
                          <div class="relative flex flex-col items-center gap-1.5 z-10 p-4 text-center">
                            <div class="w-12 h-12 rounded-full border border-primary/20 bg-surface-container/85 flex items-center justify-center text-sm font-semibold text-primary">JD</div>
                            <span class="text-xs font-semibold text-white leading-none drop-shadow-sm">BIENVENUE !</span>
                            <span class="text-[10px] font-bold text-[#57f287] leading-none font-sans">JEANDUPONT</span>
                            <span class="text-[11px] text-[#b8bcc8] font-medium uppercase tracking-wider">Membre #1,234 sur KOTBO SERVER</span>
                          </div>
                        </div>
                      {/if}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          {:else}
            <p class="text-xs text-on-surface-variant/50 italic text-center py-6">Les messages d'accueil sont désactivés.</p>
          {/if}
        </section>
      {/if}

      <!-- Leave Tab -->
      {#if activeTab === 'leave'}
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6 max-w-4xl">
          <div class="flex items-center justify-between border-b border-outline-variant/15 pb-4">
            <h3 class="text-xl font-semibold flex items-center gap-3">
              <Papicon icon="Logout" size={20} class="text-secondary" />
              Message de Départ
            </h3>
            <ToggleSwitch 
              checked={config.leaveEnabled} 
              onToggle={(v: boolean) => config.leaveEnabled = v} 
              disabled={!canManageSettings}
            />
          </div>

          {#if config.leaveEnabled}
            <div class="space-y-4 animate-in fade-in duration-300">
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div class="space-y-1.5">
                  <label for="lChannel" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Salon de diffusion</label>
                  <SearchableSelect 
                    id="lChannel"
                    bind:value={config.leaveChannelId} 
                    options={availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))} 
                    placeholder="Sélectionner le salon" 
                    className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all"
                    disabled={!canManageSettings}
                  />
                </div>
              </div>

              <div class="space-y-1.5">
                <div class="flex items-center justify-between ml-2 mb-1">
                  <label for="lMsg" class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest">Contenu du message</label>
                  <button
                    onclick={() => showLeavePresets = !showLeavePresets}
                    class="text-[10px] font-bold text-primary/70 hover:text-primary flex items-center gap-1.5 transition-colors"
                    disabled={!canManageSettings}
                  >
                    <Papicon icon="Sparkles" size={12} />
                    <span>Presets</span>
                    <span class="transition-transform duration-200 {showLeavePresets ? 'rotate-180' : ''}">▾</span>
                  </button>
                </div>
                {#if showLeavePresets}
                  <div class="flex flex-wrap gap-2 pb-2 animate-in fade-in duration-200">
                    {#each leavePresets as preset}
                      <button
                        onclick={() => { config.leaveMessage = preset.text; showLeavePresets = false; }}
                        class="text-[10px] font-bold px-3 py-1.5 rounded-xl border border-primary/20 bg-primary/5 hover:bg-primary/15 text-primary transition-all hover: flex items-center gap-1.5"
                        disabled={!canManageSettings}
                      >
                        <Papicon icon={preset.icon} size={12} />
                        {preset.label}
                      </button>
                    {/each}
                  </div>
                {/if}
                <textarea 
                  id="lMsg"
                  bind:value={config.leaveMessage} 
                  class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none h-28 resize-none"
                  placeholder="Écrivez le message de départ..."
                  disabled={!canManageSettings}
                ></textarea>
              </div>

              <div class="space-y-1.5 pt-4">
                <span class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Aperçu du rendu Discord</span>
                <div class="p-5 rounded-lg bg-surface-container-high/35 border border-outline-variant/15 text-sm text-on-surface font-semibold font-sans whitespace-pre-wrap select-none relative overflow-hidden">
                  <div class="flex items-start gap-4">
                    <div class="w-10 h-10 rounded-full bg-outline-variant/30 flex items-center justify-center text-xs font-semibold text-on-surface-variant/60">BOT</div>
                    <div>
                      <div class="flex items-center gap-2">
                        <span class="font-bold text-primary">Kotbo</span>
                        <span class="bg-primary/20 text-primary text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase leading-none">BOT</span>
                        <span class="text-[11px] text-on-surface-variant/40">Aujourd'hui à 12:05</span>
                      </div>
                      <div class="mt-1 text-on-surface-variant/90 leading-relaxed text-sm font-medium font-sans">
                        {previewText(config.leaveMessage)}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          {:else}
            <p class="text-xs text-on-surface-variant/50 italic text-center py-6">Les messages de départ sont désactivés.</p>
          {/if}
        </section>
      {/if}

      <!-- Boost Tab -->
      {#if activeTab === 'boost'}
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6 max-w-4xl">
          <div class="flex items-center justify-between border-b border-outline-variant/15 pb-4">
            <h3 class="text-xl font-semibold flex items-center gap-3">
              <Papicon icon="Zap" size={20} class="text-primary" />
              Annonces de Boost Custom
            </h3>
            <ToggleSwitch 
              checked={config.boostEnabled} 
              onToggle={(v: boolean) => config.boostEnabled = v} 
              disabled={!canManageSettings}
            />
          </div>

          {#if config.boostEnabled}
            <div class="space-y-4 animate-in fade-in duration-300">
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div class="space-y-1.5">
                  <label for="bChannel" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Salon de diffusion</label>
                  <SearchableSelect 
                    id="bChannel"
                    bind:value={config.boostChannelId} 
                    options={availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))} 
                    placeholder="Sélectionner le salon" 
                    className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all"
                    disabled={!canManageSettings}
                  />
                </div>
              </div>

              <div class="space-y-1.5">
                <div class="flex items-center justify-between ml-2 mb-1">
                  <label for="bMsg" class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest">Contenu du message de Boost</label>
                  <button
                    onclick={() => showBoostPresets = !showBoostPresets}
                    class="text-[10px] font-bold text-primary/70 hover:text-primary flex items-center gap-1.5 transition-colors"
                    disabled={!canManageSettings}
                  >
                    <Papicon icon="Sparkles" size={12} />
                    <span>Presets</span>
                    <span class="transition-transform duration-200 {showBoostPresets ? 'rotate-180' : ''}">▾</span>
                  </button>
                </div>
                {#if showBoostPresets}
                  <div class="flex flex-wrap gap-2 pb-2 animate-in fade-in duration-200">
                    {#each boostPresets as preset}
                      <button
                        onclick={() => { config.boostMessage = preset.text; showBoostPresets = false; }}
                        class="text-[10px] font-bold px-3 py-1.5 rounded-xl border border-primary/20 bg-primary/5 hover:bg-primary/15 text-primary transition-all hover: flex items-center gap-1.5"
                        disabled={!canManageSettings}
                      >
                        <Papicon icon={preset.icon} size={12} />
                        {preset.label}
                      </button>
                    {/each}
                  </div>
                {/if}
                <textarea 
                  id="bMsg"
                  bind:value={config.boostMessage} 
                  class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none h-28 resize-none"
                  placeholder="Écrivez le message à envoyer lorsqu'un membre booste..."
                  disabled={!canManageSettings}
                ></textarea>
              </div>

              <div class="p-4 rounded-lg bg-surface-container-high/20 border border-outline-variant/5 space-y-3">
                <div class="flex items-center justify-between">
                  <div>
                    <p class="text-sm font-bold">Activer l'image de boost</p>
                    <p class="text-[10px] text-on-surface-variant/50">Génère un bandeau spécial de boost</p>
                  </div>
                  <ToggleSwitch 
                    checked={config.boostImageEnabled} 
                    onToggle={(v: boolean) => config.boostImageEnabled = v} 
                    disabled={!canManageSettings}
                  />
                </div>

                {#if config.boostImageEnabled}
                  <div class="space-y-1.5 pt-2 animate-in fade-in duration-300">
                    <label for="bImgUrl" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">URL de fond d'image de boost (Optionnel)</label>
                    <input 
                      id="bImgUrl"
                      type="url" 
                      bind:value={config.boostImageUrl} 
                      placeholder="https://example.com/boost-background.png"
                      class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
                      disabled={!canManageSettings}
                    />
                  </div>
                {/if}
              </div>

              <div class="space-y-1.5">
                <span class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Aperçu du rendu Discord</span>
                <div class="p-5 rounded-lg bg-surface-container-high/35 border border-outline-variant/15 text-sm text-on-surface font-semibold font-sans whitespace-pre-wrap select-none relative overflow-hidden">
                  <div class="flex items-start gap-4">
                    <div class="w-10 h-10 rounded-full bg-outline-variant/30 flex items-center justify-center text-xs font-semibold text-on-surface-variant/60">BOT</div>
                    <div>
                      <div class="flex items-center gap-2">
                        <span class="font-bold text-primary">Kotbo</span>
                        <span class="bg-primary/20 text-primary text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase leading-none">BOT</span>
                        <span class="text-[11px] text-on-surface-variant/40">Aujourd'hui à 12:10</span>
                      </div>
                      <div class="mt-1 text-on-surface-variant/90 leading-relaxed text-sm font-medium font-sans">
                        {previewText(config.boostMessage)}
                      </div>
                      {#if config.boostImageEnabled}
                        <div class="mt-3 w-full max-w-sm aspect-5/2 rounded-xl bg-[#0b0e14] flex items-center justify-center border border-[#5865f2]/30 relative overflow-hidden">
                          {#if config.boostImageUrl}
                            <img src={config.boostImageUrl} alt="Background" class="absolute inset-0 w-full h-full object-cover opacity-50" />
                          {/if}
                          <div class="relative flex flex-col items-center gap-1.5 z-10 p-4 text-center">
                            <div class="w-12 h-12 rounded-full border border-primary/20 bg-surface-container/85 flex items-center justify-center text-sm font-semibold text-primary">JD</div>
                            <span class="text-xs font-semibold text-white leading-none drop-shadow-sm">MERCI !</span>
                            <span class="text-[10px] font-bold text-[#57f287] leading-none font-sans">JEANDUPONT</span>
                            <span class="text-[11px] text-[#b8bcc8] font-medium uppercase tracking-wider">Membre #1,234 · 18 BOOSTS</span>
                          </div>
                        </div>
                      {/if}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          {:else}
            <p class="text-xs text-on-surface-variant/50 italic text-center py-6">Les messages d'annonce de boost sont désactivés.</p>
          {/if}
        </section>
      {/if}

      <!-- Auto-Roles Tab -->
      {#if activeTab === 'autoroles'}
        <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-8 max-w-4xl">
          
          <!-- Join Auto-role -->
          <div class="space-y-4 border-b border-outline-variant/15 pb-6">
            <h3 class="text-lg font-semibold flex items-center gap-3">
              <Papicon icon="User" size={20} class="text-primary" />
              Auto-Rôle à l'arrivée (Join Auto-Role)
            </h3>
            <p class="text-xs text-on-surface-variant/70 font-medium">Attribue automatiquement un rôle spécifique à tout nouvel utilisateur qui rejoint le serveur.</p>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
              <div class="space-y-1.5">
                <label for="joinRole" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Rôle attribué</label>
                <SearchableSelect 
                  id="joinRole"
                  bind:value={config.joinRoleId} 
                  options={[
                    { id: null, name: 'Aucun (Désactivé)' },
                    ...availableRoles.map(r => ({ id: r.id, name: r.name }))
                  ]} 
                  placeholder="Choisir le rôle" 
                  className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all"
                  disabled={!canManageSettings}
                />
              </div>
            </div>
          </div>

          <!-- Tag Auto-role -->
          <div class="space-y-4 pt-2">
            <div class="flex items-center justify-between">
              <h3 class="text-lg font-semibold flex items-center gap-3">
                <Papicon icon="Bookmark" size={20} class="text-primary" />
                Auto-Rôle Tag Clan du Serveur
              </h3>
              <ToggleSwitch 
                checked={config.tagAutoRoleEnabled} 
                onToggle={(v: boolean) => config.tagAutoRoleEnabled = v} 
                disabled={!canManageSettings}
              />
            </div>
            <p class="text-xs text-on-surface-variant/70 font-medium">
              Attribue automatiquement un rôle aux membres qui affichent le tag clan de ce serveur dans leur pseudo ou nom global Discord.
              Le rôle est également retiré automatiquement si le membre supprime le tag.
            </p>
            <div class="flex items-start gap-2 p-3 rounded-lg bg-surface-container-high/20 border border-outline-variant/10">
              <span class="text-primary mt-0.5 shrink-0"><Papicon icon="Info" size={14} /></span>
              <p class="text-[11px] text-on-surface-variant/70 font-medium leading-relaxed">
                Le tag clan Discord s'affiche entre crochets à côté du pseudo d'un membre (ex : <code class="font-mono text-primary bg-primary/10 px-1 rounded">KOTBO</code> → membre affiché comme <code class="font-mono text-primary bg-primary/10 px-1 rounded">[KOTBO] JeanDupont</code>). Saisis ici le tag exact sans crochets.
              </p>
            </div>
            
            {#if config.tagAutoRoleEnabled}
              <div class="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2 animate-in fade-in duration-300">
                <div class="space-y-1.5">
                  <label for="tagWord" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Tag clan à détecter</label>
                  <input 
                    id="tagWord"
                    type="text" 
                    bind:value={config.tagAutoRoleWord} 
                    placeholder="Ex : KOTBO (sans les crochets)"
                    class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
                    disabled={!canManageSettings}
                  />
                </div>

                <div class="space-y-1.5">
                  <label for="tagRole" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Rôle à attribuer</label>
                  <SearchableSelect 
                    id="tagRole"
                    bind:value={config.tagAutoRoleId} 
                    options={availableRoles.map(r => ({ id: r.id, name: r.name }))} 
                    placeholder="Sélectionner le rôle" 
                    className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all"
                    disabled={!canManageSettings}
                  />
                </div>
              </div>
            {/if}
          </div>

        </section>
      {/if}

      <!-- Thread d'accueil Tab -->
      {#if activeTab === 'thread'}
        {#if threadLoading}
          <div class="max-w-4xl space-y-6">
            <Skeleton height="220px" radius="1.5rem" />
            <Skeleton height="300px" radius="1.5rem" />
          </div>
        {:else}
          <div class="space-y-8 max-w-4xl animate-in fade-in duration-300">
            <InlineFeedback state={threadActionState} />

            <!-- General settings -->
            <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
              <div class="flex items-center justify-between border-b border-outline-variant/15 pb-4">
                <h3 class="text-xl font-semibold flex items-center gap-3">
                  <Papicon icon="chat" size={20} class="text-primary" />
                  Thread d'accueil scénarisé
                </h3>
                <ToggleSwitch
                  checked={threadConfig.enabled}
                  onToggle={(v: boolean) => threadConfig.enabled = v}
                  disabled={!canManageSettings}
                />
              </div>

              <p class="text-xs text-on-surface-variant/70 font-medium">
                À l'arrivée d'un membre, le bot crée un thread dédié dans le salon choisi, y envoie une séquence de messages scénarisés (persona webhook + indicateur de frappe), puis un menu de présentation du serveur.
              </p>

              {#if threadConfig.enabled}
                <div class="space-y-5 animate-in fade-in duration-300">
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div class="space-y-1.5">
                      <label for="threadChannel" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Salon parent des threads</label>
                      <SearchableSelect
                        id="threadChannel"
                        bind:value={threadConfig.channelId}
                        options={availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))}
                        placeholder="Sélectionner le salon"
                        className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all"
                        disabled={!canManageSettings}
                      />
                    </div>
                    <div class="space-y-1.5">
                      <span class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Mode du thread</span>
                      <div class="inline-flex w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 p-1 gap-1">
                        <button
                          type="button"
                          onclick={() => threadConfig.threadMode = 'public'}
                          disabled={!canManageSettings}
                          class="flex-1 px-4 py-2.5 rounded-md text-[13px] font-medium transition-all {threadConfig.threadMode === 'public' ? 'bg-primary text-on-primary' : 'text-on-surface-variant/60 hover:text-on-surface'}"
                        >
                          Public
                        </button>
                        <button
                          type="button"
                          onclick={() => threadConfig.threadMode = 'private'}
                          disabled={!canManageSettings}
                          class="flex-1 px-4 py-2.5 rounded-md text-[13px] font-medium transition-all {threadConfig.threadMode === 'private' ? 'bg-primary text-on-primary' : 'text-on-surface-variant/60 hover:text-on-surface'}"
                        >
                          Privé
                        </button>
                      </div>
                    </div>
                  </div>

                  <div class="space-y-1.5">
                    <label for="threadNameTemplate" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Modèle du nom de thread</label>
                    <input
                      id="threadNameTemplate"
                      type="text"
                      bind:value={threadConfig.threadNameTemplate}
                      placeholder={`👋 Bienvenue {username} !`}
                      class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
                      disabled={!canManageSettings}
                    />
                  </div>

                  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div class="space-y-1.5">
                      <label for="autoArchive" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Archivage automatique</label>
                      <select
                        id="autoArchive"
                        bind:value={threadConfig.autoArchiveMinutes}
                        class="w-full bg-surface-container-high/45 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm text-on-surface focus:outline-none"
                        disabled={!canManageSettings}
                      >
                        {#each autoArchiveOptions as opt}
                          <option value={opt.value}>{opt.label}</option>
                        {/each}
                      </select>
                    </div>
                    <div class="flex items-center justify-between p-4 rounded-lg bg-surface-container-high/20 border border-outline-variant/5">
                      <div>
                        <p class="text-sm font-bold">Indicateur de frappe</p>
                        <p class="text-[10px] text-on-surface-variant/50">Affiche « est en train d'écrire » avant chaque message</p>
                      </div>
                      <ToggleSwitch
                        checked={threadConfig.typingEnabled}
                        onToggle={(v: boolean) => threadConfig.typingEnabled = v}
                        disabled={!canManageSettings}
                      />
                    </div>
                  </div>

                  <div class="p-4 rounded-lg bg-surface-container-high/20 border border-outline-variant/5 space-y-4">
                    <h4 class="text-sm font-bold flex items-center gap-2">
                      <Papicon icon="User" size={14} class="text-primary" />
                      Persona par défaut (Webhook)
                    </h4>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div class="space-y-1.5">
                        <label for="webhookName" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Nom affiché</label>
                        <input
                          id="webhookName"
                          type="text"
                          bind:value={threadConfig.webhookName}
                          placeholder="Kotbo"
                          class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
                          disabled={!canManageSettings}
                        />
                      </div>
                      <div class="space-y-1.5">
                        <label for="webhookAvatar" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Avatar (URL, optionnel)</label>
                        <input
                          id="webhookAvatar"
                          type="url"
                          bind:value={threadConfig.webhookAvatarUrl}
                          placeholder="https://example.com/avatar.png"
                          class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
                          disabled={!canManageSettings}
                        />
                      </div>
                    </div>
                    <p class="text-[11px] text-on-surface-variant/60">Chaque message de la séquence peut surcharger ce nom et cet avatar individuellement.</p>
                  </div>

                  <!-- Final menu embed -->
                  <div class="pt-4 border-t border-outline-variant/10 space-y-4">
                    <div class="flex items-center justify-between">
                      <h4 class="text-sm font-bold flex items-center gap-2">
                        <Papicon icon="menu" size={14} class="text-primary" />
                        Menu de présentation final
                      </h4>
                      <ToggleSwitch
                        checked={threadConfig.menuEnabled}
                        onToggle={(v: boolean) => threadConfig.menuEnabled = v}
                        disabled={!canManageSettings}
                      />
                    </div>

                    {#if threadConfig.menuEnabled}
                      <div class="space-y-4 animate-in fade-in duration-300">
                        <div class="space-y-1.5">
                          <span class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Style du menu</span>
                          <div class="inline-flex w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 p-1 gap-1">
                            <button
                              type="button"
                              onclick={() => threadConfig.menuStyle = 'buttons'}
                              disabled={!canManageSettings}
                              class="flex-1 px-4 py-2.5 rounded-md text-[13px] font-medium transition-all {threadConfig.menuStyle === 'buttons' ? 'bg-primary text-on-primary' : 'text-on-surface-variant/60 hover:text-on-surface'}"
                            >
                              Boutons
                            </button>
                            <button
                              type="button"
                              onclick={() => threadConfig.menuStyle = 'select'}
                              disabled={!canManageSettings}
                              class="flex-1 px-4 py-2.5 rounded-md text-[13px] font-medium transition-all {threadConfig.menuStyle === 'select' ? 'bg-primary text-on-primary' : 'text-on-surface-variant/60 hover:text-on-surface'}"
                            >
                              Menu déroulant
                            </button>
                          </div>
                        </div>

                        {#if threadConfig.menuStyle === 'select'}
                          <div class="space-y-1.5 animate-in fade-in duration-200">
                            <label for="menuPlaceholder" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Texte du placeholder</label>
                            <input
                              id="menuPlaceholder"
                              type="text"
                              bind:value={threadConfig.menuPlaceholder}
                              placeholder="Découvrir le serveur..."
                              class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
                              disabled={!canManageSettings}
                            />
                          </div>
                        {/if}

                        <div class="space-y-1.5">
                          <label for="menuEmbedTitle" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Titre de l'embed</label>
                          <input
                            id="menuEmbedTitle"
                            type="text"
                            bind:value={threadConfig.embedTitle}
                            placeholder={`Bienvenue sur {server} !`}
                            class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none"
                            disabled={!canManageSettings}
                          />
                        </div>

                        <div class="space-y-1.5">
                          <label for="menuEmbedDesc" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Description</label>
                          <textarea
                            id="menuEmbedDesc"
                            bind:value={threadConfig.embedDescription}
                            class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none h-24 resize-none"
                            disabled={!canManageSettings}
                          ></textarea>
                        </div>

                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <div class="space-y-1.5">
                            <label for="menuEmbedColor" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Couleur</label>
                            <div class="flex gap-2">
                              <input
                                id="menuEmbedColor"
                                type="color"
                                bind:value={threadConfig.embedColor}
                                class="w-11 h-11 border-0 bg-transparent rounded-lg cursor-pointer shrink-0"
                                disabled={!canManageSettings}
                              />
                              <input
                                type="text"
                                bind:value={threadConfig.embedColor}
                                placeholder="#5865F2"
                                class="flex-1 bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-2 text-sm focus:outline-none font-mono"
                                disabled={!canManageSettings}
                              />
                            </div>
                          </div>
                          <div class="space-y-1.5">
                            <label for="menuEmbedImg" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Image (URL)</label>
                            <input
                              id="menuEmbedImg"
                              type="url"
                              bind:value={threadConfig.embedImageUrl}
                              placeholder="https://example.com/banner.png"
                              class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none"
                              disabled={!canManageSettings}
                            />
                          </div>
                        </div>
                        <div class="space-y-1.5">
                          <label for="menuEmbedThumb" class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Miniature (URL)</label>
                          <input
                            id="menuEmbedThumb"
                            type="url"
                            bind:value={threadConfig.embedThumbnailUrl}
                            placeholder="https://example.com/thumb.png"
                            class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:outline-none"
                            disabled={!canManageSettings}
                          />
                        </div>

                        <!-- Preview -->
                        <div class="space-y-1.5">
                          <span class="text-[10px] font-bold text-on-surface-variant/60 ml-2 uppercase tracking-widest">Aperçu de l'embed final</span>
                          <div class="p-5 rounded-lg bg-surface-container-high/35 border-l-4 relative overflow-hidden" style="border-left-color: {threadConfig.embedColor || '#5865F2'}">
                            <div class="flex gap-4">
                              {#if threadConfig.embedThumbnailUrl}
                                <img src={threadConfig.embedThumbnailUrl} alt="" class="w-16 h-16 rounded-lg object-cover shrink-0 order-2 ml-auto" />
                              {/if}
                              <div class="flex-1 min-w-0">
                                <p class="text-sm font-bold text-on-surface">{previewText(threadConfig.embedTitle) || "Titre de l'embed"}</p>
                                <p class="mt-1 text-xs text-on-surface-variant/80 whitespace-pre-wrap leading-relaxed">{previewText(threadConfig.embedDescription) || 'Description...'}</p>
                              </div>
                            </div>
                            {#if threadConfig.embedImageUrl}
                              <img src={threadConfig.embedImageUrl} alt="" class="mt-3 w-full max-w-sm rounded-lg object-cover" />
                            {/if}
                            {#if threadConfig.menuStyle === 'buttons'}
                              <div class="flex flex-wrap gap-2 mt-4">
                                {#each (threadPages.length > 0 ? threadPages : [{ localId: 'x', label: 'Exemple', emoji: '', actionType: 'EMBED' }]) as page}
                                  <span class="text-[11px] font-semibold px-3 py-2 rounded-lg border {page.actionType === 'ROLE' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-500' : page.actionType === 'LINK' ? 'bg-sky-500/10 border-sky-500/20 text-sky-500' : 'bg-surface-container-high border-outline-variant/15 text-on-surface-variant/80'}">
                                    {#if page.emoji}{page.emoji} {/if}{page.label || 'Page sans nom'}{#if page.actionType === 'ROLE'} 🎭{:else if page.actionType === 'LINK'} 🔗{/if}
                                  </span>
                                {/each}
                              </div>
                            {:else}
                              <div class="mt-4 text-[11px] font-semibold px-3 py-2.5 rounded-lg bg-surface-container-high border border-outline-variant/15 text-on-surface-variant/60 max-w-xs">
                                {threadConfig.menuPlaceholder || 'Découvrir le serveur...'} ▾
                              </div>
                            {/if}
                          </div>
                        </div>
                      </div>
                    {/if}
                  </div>
                </div>
              {/if}

              <div class="flex justify-end pt-4 border-t border-outline-variant/10">
                <ActionButton
                  onClick={saveThreadConfig}
                  variant="primary"
                  icon="Check"
                  label={threadActionState.state.loading ? 'Enregistrement...' : 'Enregistrer les paramètres'}
                  disabled={!canManageSettings || !threadConfigDirty || threadActionState.state.loading}
                  className="px-8 py-3 rounded-xl shadow-sm shadow-primary/20"
                />
              </div>
            </section>

            <!-- Steps builder -->
            <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
              <div class="flex items-center justify-between border-b border-outline-variant/15 pb-4">
                <div>
                  <h3 class="text-xl font-semibold flex items-center gap-3">
                    <Papicon icon="List" size={20} class="text-primary" />
                    Séquence de messages scénarisés
                  </h3>
                  <p class="text-xs text-on-surface-variant/60 font-medium mt-1">Messages envoyés dans l'ordre, avant le menu final. {threadSteps.length}/{MAX_THREAD_STEPS}</p>
                </div>
                <ActionButton
                  onClick={addStep}
                  variant="muted"
                  icon="Plus"
                  label="Ajouter"
                  disabled={!canManageSettings || threadSteps.length >= MAX_THREAD_STEPS}
                  className="px-5 py-2.5 rounded-xl"
                />
              </div>

              {#if threadSteps.length === 0}
                <p class="text-xs text-on-surface-variant/50 italic text-center py-6">Aucun message scénarisé. Le bot passera directement au menu final.</p>
              {:else}
                <div class="space-y-4">
                  {#each threadSteps as step, index (step.localId)}
                    <div class="p-5 rounded-lg bg-surface-container-high/20 border border-outline-variant/10 space-y-3">
                      <div class="flex items-center justify-between">
                        <span class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest">Message {index + 1}</span>
                        <div class="flex items-center gap-1">
                          <button type="button" onclick={() => moveStep(index, -1)} disabled={!canManageSettings || index === 0} class="p-2 rounded-lg hover:bg-surface-container-high text-on-surface-variant/60 disabled:opacity-30 transition-all" title="Monter">
                            <Papicon icon="ArrowUp" size={14} />
                          </button>
                          <button type="button" onclick={() => moveStep(index, 1)} disabled={!canManageSettings || index === threadSteps.length - 1} class="p-2 rounded-lg hover:bg-surface-container-high text-on-surface-variant/60 disabled:opacity-30 transition-all" title="Descendre">
                            <Papicon icon="ArrowDown" size={14} />
                          </button>
                          <button type="button" onclick={() => removeStep(index)} disabled={!canManageSettings} class="p-2 rounded-lg hover:bg-error-container/20 hover:text-error text-on-surface-variant/60 transition-all" title="Supprimer">
                            <Papicon icon="Trash" size={14} />
                          </button>
                        </div>
                      </div>

                      <textarea
                        bind:value={step.content}
                        placeholder="Contenu du message (2000 caractères max)..."
                        maxlength="2000"
                        class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-primary/30 transition-all text-on-surface focus:outline-none h-20 resize-none"
                        disabled={!canManageSettings}
                      ></textarea>

                      <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <div class="space-y-1">
                          <label for="step-name-{index}" class="text-[9px] font-bold text-on-surface-variant/50 ml-1 uppercase tracking-widest">Nom persona (optionnel)</label>
                          <input
                            id="step-name-{index}"
                            type="text"
                            bind:value={step.name}
                            placeholder={threadConfig.webhookName || 'Kotbo'}
                            class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:outline-none"
                            disabled={!canManageSettings}
                          />
                        </div>
                        <div class="space-y-1">
                          <label for="step-avatar-{index}" class="text-[9px] font-bold text-on-surface-variant/50 ml-1 uppercase tracking-widest">Avatar persona (URL, optionnel)</label>
                          <input
                            id="step-avatar-{index}"
                            type="url"
                            bind:value={step.avatarUrl}
                            placeholder="https://..."
                            class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:outline-none"
                            disabled={!canManageSettings}
                          />
                        </div>
                        <div class="space-y-1">
                          <label for="step-delay-{index}" class="text-[9px] font-bold text-on-surface-variant/50 ml-1 uppercase tracking-widest">Délai avant envoi (ms)</label>
                          <input
                            id="step-delay-{index}"
                            type="number"
                            min="250"
                            max="120000"
                            step="250"
                            bind:value={step.delayMs}
                            class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:outline-none"
                            disabled={!canManageSettings}
                          />
                        </div>
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}

              <div class="flex justify-end pt-4 border-t border-outline-variant/10">
                <ActionButton
                  onClick={saveThreadSteps}
                  variant="primary"
                  icon="Check"
                  label={threadActionState.state.loading ? 'Enregistrement...' : 'Enregistrer la séquence'}
                  disabled={!canManageSettings || !threadStepsDirty || threadActionState.state.loading}
                  className="px-8 py-3 rounded-xl shadow-sm shadow-primary/20"
                />
              </div>
            </section>

            <!-- Menu pages builder -->
            <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-6">
              <div class="flex items-center justify-between border-b border-outline-variant/15 pb-4">
                <div>
                  <h3 class="text-xl font-semibold flex items-center gap-3">
                    <Papicon icon="menu" size={20} class="text-primary" />
                    Pages de présentation du menu
                  </h3>
                  <p class="text-xs text-on-surface-variant/60 font-medium mt-1">Chaque page devient un bouton ou une option du menu final. {threadPages.length}/{MAX_MENU_PAGES}</p>
                </div>
                <ActionButton
                  onClick={addPage}
                  variant="muted"
                  icon="Plus"
                  label="Ajouter"
                  disabled={!canManageSettings || threadPages.length >= MAX_MENU_PAGES}
                  className="px-5 py-2.5 rounded-xl"
                />
              </div>

              {#if threadPages.length === 0}
                <p class="text-xs text-on-surface-variant/50 italic text-center py-6">Aucune page configurée. Le menu final n'affichera aucun bouton.</p>
              {:else}
                <div class="space-y-4">
                  {#each threadPages as page, index (page.localId)}
                    <div class="p-5 rounded-lg bg-surface-container-high/20 border border-outline-variant/10 space-y-3">
                      <div class="flex items-center justify-between">
                        <span class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest">Page {index + 1}</span>
                        <div class="flex items-center gap-1">
                          <button type="button" onclick={() => movePage(index, -1)} disabled={!canManageSettings || index === 0} class="p-2 rounded-lg hover:bg-surface-container-high text-on-surface-variant/60 disabled:opacity-30 transition-all" title="Monter">
                            <Papicon icon="ArrowUp" size={14} />
                          </button>
                          <button type="button" onclick={() => movePage(index, 1)} disabled={!canManageSettings || index === threadPages.length - 1} class="p-2 rounded-lg hover:bg-surface-container-high text-on-surface-variant/60 disabled:opacity-30 transition-all" title="Descendre">
                            <Papicon icon="ArrowDown" size={14} />
                          </button>
                          <button type="button" onclick={() => removePage(index)} disabled={!canManageSettings} class="p-2 rounded-lg hover:bg-error-container/20 hover:text-error text-on-surface-variant/60 transition-all" title="Supprimer">
                            <Papicon icon="Trash" size={14} />
                          </button>
                        </div>
                      </div>

                      <div class="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-3">
                        <div class="space-y-1">
                          <label for="page-label-{index}" class="text-[9px] font-bold text-on-surface-variant/50 ml-1 uppercase tracking-widest">Label</label>
                          <input
                            id="page-label-{index}"
                            type="text"
                            bind:value={page.label}
                            maxlength="80"
                            placeholder="Ex : Règlement"
                            class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:outline-none"
                            disabled={!canManageSettings}
                          />
                        </div>
                        <div class="space-y-1">
                          <span class="text-[9px] font-bold text-on-surface-variant/50 ml-1 uppercase tracking-widest block">Émoji</span>
                          <EmojiPicker bind:value={page.emoji} disabled={!canManageSettings} />
                        </div>
                        <div class="space-y-1">
                          <label for="page-summary-{index}" class="text-[9px] font-bold text-on-surface-variant/50 ml-1 uppercase tracking-widest">Sous-texte (menu déroulant)</label>
                          <input
                            id="page-summary-{index}"
                            type="text"
                            bind:value={page.summary}
                            maxlength="100"
                            placeholder="Optionnel"
                            class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:outline-none"
                            disabled={!canManageSettings}
                          />
                        </div>
                      </div>

                      <div class="space-y-1.5">
                        <span class="text-[9px] font-bold text-on-surface-variant/50 ml-1 uppercase tracking-widest">Action au clic</span>
                        <div class="inline-flex w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 p-1 gap-1">
                          <button
                            type="button"
                            onclick={() => page.actionType = 'EMBED'}
                            disabled={!canManageSettings}
                            class="flex-1 px-3 py-2 rounded-md text-xs font-medium transition-all {page.actionType === 'EMBED' ? 'bg-primary text-on-primary' : 'text-on-surface-variant/60 hover:text-on-surface'}"
                          >
                            Afficher un embed
                          </button>
                          <button
                            type="button"
                            onclick={() => page.actionType = 'ROLE'}
                            disabled={!canManageSettings}
                            class="flex-1 px-3 py-2 rounded-md text-xs font-medium transition-all {page.actionType === 'ROLE' ? 'bg-primary text-on-primary' : 'text-on-surface-variant/60 hover:text-on-surface'}"
                          >
                            Gérer un rôle
                          </button>
                          <button
                            type="button"
                            onclick={() => page.actionType = 'LINK'}
                            disabled={!canManageSettings}
                            class="flex-1 px-3 py-2 rounded-md text-xs font-medium transition-all {page.actionType === 'LINK' ? 'bg-primary text-on-primary' : 'text-on-surface-variant/60 hover:text-on-surface'}"
                          >
                            Lien
                          </button>
                        </div>
                      </div>

                      {#if page.actionType === 'EMBED'}
                        <div class="space-y-3 animate-in fade-in duration-200">
                          <div class="space-y-1">
                            <label for="page-embed-title-{index}" class="text-[9px] font-bold text-on-surface-variant/50 ml-1 uppercase tracking-widest">Titre de l'embed</label>
                            <input
                              id="page-embed-title-{index}"
                              type="text"
                              bind:value={page.embedTitle}
                              placeholder="Titre affiché à l'ouverture"
                              class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:outline-none"
                              disabled={!canManageSettings}
                            />
                          </div>
                          <div class="space-y-1">
                            <label for="page-embed-desc-{index}" class="text-[9px] font-bold text-on-surface-variant/50 ml-1 uppercase tracking-widest">Description de l'embed</label>
                            <textarea
                              id="page-embed-desc-{index}"
                              bind:value={page.embedDescription}
                              class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:outline-none h-20 resize-none"
                              disabled={!canManageSettings}
                            ></textarea>
                          </div>
 
                          <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
                            <div class="space-y-1">
                              <span class="text-[9px] font-bold text-on-surface-variant/50 ml-1 uppercase tracking-widest block">Couleur</span>
                              <div class="flex gap-2">
                                <input type="color" bind:value={page.embedColor} class="w-9 h-9 border-0 bg-transparent rounded-lg cursor-pointer shrink-0" disabled={!canManageSettings} aria-label="Couleur de l'embed" />
                                <input type="text" bind:value={page.embedColor} placeholder="#5865F2" class="flex-1 bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:outline-none font-mono" disabled={!canManageSettings} aria-label="Couleur de l'embed (hex)" />
                              </div>
                            </div>
                            <div class="space-y-1">
                              <label for="page-embed-image-{index}" class="text-[9px] font-bold text-on-surface-variant/50 ml-1 uppercase tracking-widest">Image (URL)</label>
                              <input id="page-embed-image-{index}" type="url" bind:value={page.embedImageUrl} placeholder="https://..." class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:outline-none" disabled={!canManageSettings} />
                            </div>
                            <div class="space-y-1">
                              <label for="page-embed-thumbnail-{index}" class="text-[9px] font-bold text-on-surface-variant/50 ml-1 uppercase tracking-widest">Miniature (URL)</label>
                              <input id="page-embed-thumbnail-{index}" type="url" bind:value={page.embedThumbnailUrl} placeholder="https://..." class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:outline-none" disabled={!canManageSettings} />
                            </div>
                          </div>
                        </div>
                      {:else if page.actionType === 'ROLE'}
                        <div class="space-y-3 animate-in fade-in duration-200">
                          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div class="space-y-1">
                              <span class="text-[9px] font-bold text-on-surface-variant/50 ml-1 uppercase tracking-widest block">Rôle</span>
                              <SearchableSelect
                                bind:value={page.roleId}
                                options={availableRoles.map(r => ({ id: r.id, name: `@${r.name}` }))}
                                placeholder="Sélectionner le rôle"
                                className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:ring-2 focus:ring-primary/30 transition-all"
                                disabled={!canManageSettings}
                              />
                            </div>
                            <div class="space-y-1">
                              <span class="text-[9px] font-bold text-on-surface-variant/50 ml-1 uppercase tracking-widest block">Comportement</span>
                              <div class="grid grid-cols-2 sm:grid-cols-4 w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 p-1 gap-1">
                                <button type="button" onclick={() => page.roleAction = 'ADD'} disabled={!canManageSettings} class="flex-1 px-2 py-2 rounded-md text-xs font-medium transition-all {page.roleAction === 'ADD' ? 'bg-primary text-on-primary' : 'text-on-surface-variant/60 hover:text-on-surface'}">Ajouter</button>
                                <button type="button" onclick={() => page.roleAction = 'REMOVE'} disabled={!canManageSettings} class="flex-1 px-2 py-2 rounded-md text-xs font-medium transition-all {page.roleAction === 'REMOVE' ? 'bg-primary text-on-primary' : 'text-on-surface-variant/60 hover:text-on-surface'}">Retirer</button>
                                <button type="button" onclick={() => page.roleAction = 'TOGGLE'} disabled={!canManageSettings} class="flex-1 px-2 py-2 rounded-md text-xs font-medium transition-all {page.roleAction === 'TOGGLE' ? 'bg-primary text-on-primary' : 'text-on-surface-variant/60 hover:text-on-surface'}">Basculer</button>
                                <button type="button" onclick={() => page.roleAction = 'EXCLUSIVE'} disabled={!canManageSettings} class="flex-1 px-2 py-2 rounded-md text-xs font-medium transition-all {page.roleAction === 'EXCLUSIVE' ? 'bg-amber-500 text-white' : 'text-on-surface-variant/60 hover:text-on-surface'}">Exclusif</button>
                              </div>
                            </div>
                          </div>
                          {#if page.roleAction === 'EXCLUSIVE'}
                            {@const groupMembers = exclusiveGroupMembers(page)}
                            <div class="rounded-lg border border-amber-500/20 bg-amber-500/5 p-4 space-y-3">
                              <div class="space-y-1">
                                <label for="page-role-group-{index}" class="text-[9px] font-bold text-amber-600 dark:text-amber-400 ml-1 uppercase tracking-widest">Groupe exclusif</label>
                                <input
                                  id="page-role-group-{index}"
                                  type="text"
                                  bind:value={page.roleGroup}
                                  list="exclusive-role-groups-{index}"
                                  maxlength="64"
                                  placeholder="Ex : Clans"
                                  class="w-full bg-surface-container-high/50 border border-amber-500/20 rounded-lg px-3 py-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-amber-500/25"
                                  disabled={!canManageSettings}
                                />
                                <datalist id="exclusive-role-groups-{index}">
                                  {#each exclusiveGroupNames(page) as groupName}
                                    <option value={groupName}></option>
                                  {/each}
                                </datalist>
                              </div>
                              <div class="flex flex-wrap items-center gap-2">
                                <span class="text-[10px] font-semibold text-on-surface-variant/60">Choix liés :</span>
                                {#if groupMembers.length > 0}
                                  {#each groupMembers as memberPage}
                                    <span class="rounded-md border border-amber-500/15 bg-amber-500/10 px-2 py-1 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                                      {memberPage.label || 'Page sans nom'}
                                    </span>
                                  {/each}
                                {:else}
                                  <span class="text-[10px] text-on-surface-variant/45 italic">Saisissez un nom de groupe.</span>
                                {/if}
                              </div>
                              {#if normalizeRoleGroupName(page.roleGroup) && groupMembers.length < 2}
                                <p class="text-[10px] text-amber-700 dark:text-amber-300">Ajoutez au moins une autre page « Rôle » dans ce même groupe. Choisir l'un retirera automatiquement les autres.</p>
                              {:else if groupMembers.length >= 2}
                                <p class="text-[10px] text-on-surface-variant/60">Ce rôle remplacera automatiquement tout autre rôle actuellement détenu dans le groupe.</p>
                              {/if}
                            </div>
                          {:else}
                            <p class="text-[11px] text-on-surface-variant/60">« Basculer » ajoute le rôle s'il est absent, et le retire s'il est déjà présent.</p>
                          {/if}
                        </div>
                      {:else if page.actionType === 'LINK'}
                        <div class="space-y-3 animate-in fade-in duration-200">
                          <div class="inline-flex w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/40 p-1 gap-1">
                            <button type="button" onclick={() => page.linkMode = 'channel'} disabled={!canManageSettings} class="flex-1 px-3 py-2 rounded-md text-xs font-medium transition-all {page.linkMode === 'channel' ? 'bg-primary text-on-primary' : 'text-on-surface-variant/60 hover:text-on-surface'}" aria-label="Lien vers un salon du serveur">Salon du serveur</button>
                            <button type="button" onclick={() => page.linkMode = 'url'} disabled={!canManageSettings} class="flex-1 px-3 py-2 rounded-md text-xs font-medium transition-all {page.linkMode === 'url' ? 'bg-primary text-on-primary' : 'text-on-surface-variant/60 hover:text-on-surface'}" aria-label="Lien vers une URL externe">URL externe</button>
                          </div>
                          {#if page.linkMode === 'channel'}
                            <div class="space-y-1">
                              <span class="text-[9px] font-bold text-on-surface-variant/50 ml-1 uppercase tracking-widest block">Salon</span>
                              <SearchableSelect
                                bind:value={page.linkChannelId}
                                options={availableChannels.map(c => ({ id: c.id, name: channelDisplayName(c) }))}
                                placeholder="Sélectionner le salon"
                                className="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:ring-2 focus:ring-primary/30 transition-all"
                                disabled={!canManageSettings}
                              />
                            </div>
                          {:else}
                            <div class="space-y-1">
                              <label for="page-link-url-{index}" class="text-[9px] font-bold text-on-surface-variant/50 ml-1 uppercase tracking-widest">URL externe</label>
                              <input
                                id="page-link-url-{index}"
                                type="url"
                                bind:value={page.linkUrl}
                                placeholder="https://example.com"
                                class="w-full bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-3 py-2 text-xs focus:outline-none"
                                disabled={!canManageSettings}
                              />
                            </div>
                          {/if}
                          <p class="text-[11px] text-on-surface-variant/60">Uniquement disponible en style « Boutons » : Discord affiche alors un vrai bouton de lien qui ouvre directement le salon ou l'URL, sans passer par le bot.</p>
                        </div>
                      {/if}
                    </div>
                  {/each}
                </div>
              {/if}

              <div class="flex justify-end pt-4 border-t border-outline-variant/10">
                <ActionButton
                  onClick={saveThreadPages}
                  variant="primary"
                  icon="Check"
                  label={threadActionState.state.loading ? 'Enregistrement...' : 'Enregistrer les pages'}
                  disabled={!canManageSettings || !threadPagesDirty || threadActionState.state.loading}
                  className="px-8 py-3 rounded-xl shadow-sm shadow-primary/20"
                />
              </div>
            </section>
          </div>
        {/if}
      {/if}

    </div>
  {/if}
</ModulePage>
