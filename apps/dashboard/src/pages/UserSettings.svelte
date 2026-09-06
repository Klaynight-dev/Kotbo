<script lang="ts">
  import { router } from 'tinro';
  import { authStore } from '../lib/stores/auth.svelte';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import ProfileWidgetPanel from '../lib/components/ProfileWidgetPanel.svelte';
  import { userPrefs } from '../lib/stores/userPreferences.svelte';
  import { timezoneStore } from '../lib/stores/timezone.svelte';
  import { listSupportedTimezones } from '@kotbo/contracts';
  import { themeStore, THEME_PRESETS, ACCENT_COLORS, type ThemeId, type CustomThemeColors, type AccentColorId } from '../lib/stores/theme.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import { m } from '../lib/i18n';
  import { memberAvatarSrc } from '../lib/discordMedia';

  import type { DateFormat, Language, SidebarBehavior } from '../lib/stores/userPreferences.svelte';

  const getUserAvatar = () => {
    const hash = authStore.user?.avatar;
    const id = authStore.user?.id;
    const url = id && hash ? `https://cdn.discordapp.com/avatars/${id}/${hash}.png` : null;
    return memberAvatarSrc(url, authStore.user?.username, id);
  };

  const SETTINGS_BASE = '/userSettings';
  const settingsTabs = ['preferences', 'widget'] as const;
  let activeTab = $state<string>('preferences');

  $effect(() => {
    const _path = $router.path;
    activeTab = resolveTabFromUrl(SETTINGS_BASE, settingsTabs, 'preferences');
  });

  const tabs = $derived([
    { id: 'preferences', label: m.us_tab_preferences(), icon: 'Gears' },
    { id: 'widget', label: m.us_tab_widget(), icon: 'Layout' },
  ]);

  let savedFeedback = $state(false);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let importInput = $state<HTMLInputElement | null>(null);

  function showSavedFeedback() {
    savedFeedback = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      savedFeedback = false;
    }, 2000);
  }

  const customColors = $state<CustomThemeColors>({ ...themeStore.customColors });
  let showCustomEditor = $state(false);

  function handleToggle<K extends keyof typeof userPrefs.prefs>(key: K, value: any) {
    userPrefs.set(key, value);
    if (key === 'theme') {
      themeStore.themeId = value as ThemeId;
      showCustomEditor = value === 'custom';
    }
    showSavedFeedback();
  }

  function applyCustomTheme() {
    themeStore.setCustomColors(customColors);
    themeStore.themeId = 'custom';
    userPrefs.set('theme', 'custom');
    showSavedFeedback();
  }

  function exportPreferences() {
    const payload = JSON.stringify(userPrefs.prefs, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'kotbo-user-preferences.json';
    link.click();
    URL.revokeObjectURL(url);
    toast.success(m.us_export_started());
  }

  function openImportDialog() {
    importInput?.click();
  }

  async function handleImportFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];

    if (!file) {
      return;
    }

    try {
      const raw = await file.text();
      const imported = JSON.parse(raw) as Partial<typeof userPrefs.prefs>;
      const allowedKeys = Object.keys(userPrefs.prefs) as Array<keyof typeof userPrefs.prefs>;

      for (const key of allowedKeys) {
        if (key in imported) {
          userPrefs.set(key, imported[key] as any);
        }
      }

      toast.success(m.us_import_success());
      showSavedFeedback();
    } catch {
      toast.error(m.us_import_invalid());
    } finally {
      input.value = '';
    }
  }

  async function testNotifications() {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      toast.warning(m.us_notif_unavailable());
      return;
    }

    const permission = Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission();

    if (permission !== 'granted') {
      toast.error(m.us_notif_denied());
      return;
    }

    new Notification('Kotbo', {
      body: m.us_notif_preview_body(),
    });

    if (userPrefs.prefs.soundNotifications) {
      try {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioContextClass) {
          const context = new AudioContextClass();
          const oscillator = context.createOscillator();
          const gain = context.createGain();

          oscillator.type = 'sine';
          oscillator.frequency.value = 880;
          gain.gain.value = 0.02;

          oscillator.connect(gain);
          gain.connect(context.destination);
          oscillator.start();
          oscillator.stop(context.currentTime + 0.12);
        }
      } catch {
        // Ignore audio preview errors.
      }
    }

    toast.success(m.us_notif_preview_sent());
  }

  const activeThemeLabel = $derived(
    THEME_PRESETS.find(p => p.id === themeStore.themeId)?.label ?? 'Custom'
  );
  const activeSummary = $derived([
    { label: m.us_summary_theme(), value: activeThemeLabel },
    { label: m.us_summary_accent(), value: userPrefs.prefs.accentColor },
    { label: m.settings_language(), value: userPrefs.prefs.language === 'fr' ? m.settings_language_fr() : m.settings_language_en() },
    { label: m.us_summary_dates(), value: userPrefs.prefs.dateFormat },
    { label: m.us_summary_sidebar(), value: userPrefs.prefs.sidebarBehavior },
  ]);

  const accentColors: { id: AccentColorId; label: string; hex: string }[] = [
    { id: 'violet', label: m.us_color_violet(), hex: ACCENT_COLORS.violet.hex },
    { id: 'blue',   label: m.us_color_blue(),   hex: ACCENT_COLORS.blue.hex },
    { id: 'green',  label: m.us_color_green(),  hex: ACCENT_COLORS.green.hex },
    { id: 'rose',   label: m.us_color_rose(),   hex: ACCENT_COLORS.rose.hex },
    { id: 'orange', label: m.us_color_orange(), hex: ACCENT_COLORS.orange.hex },
    { id: 'cyan',   label: m.us_color_cyan(),   hex: ACCENT_COLORS.cyan.hex },
  ];

  const languages: { id: Language; label: string; flag: string }[] = [
    { id: 'fr', label: m.settings_language_fr(), flag: '🇫🇷' },
    { id: 'en', label: m.settings_language_en(),  flag: '🇬🇧' },
  ];

  const dateFormats: { id: DateFormat; label: string; example: string }[] = [
    { id: 'relative', label: m.us_datefmt_relative(), example: m.us_datefmt_relative_ex() },
    { id: 'absolute', label: m.us_datefmt_absolute(), example: m.us_datefmt_absolute_ex() },
    { id: 'both',     label: m.us_datefmt_both(), example: m.us_datefmt_both_ex() },
  ];

  /**
   * Fuseau de lecture des statistiques. `auto` suit le navigateur, ce qui est
   * deja correct pour la plupart des lecteurs ; le choix explicite sert a qui
   * pilote un serveur depuis un autre fuseau que celui ou il vit.
   */
  const timezoneChoice = $derived(userPrefs.prefs.timezone ?? 'auto');
  const timezoneZones = $derived(listSupportedTimezones(timezoneStore.displayTimezone));

  function handleTimezone(value: string) {
    userPrefs.set('timezone', value === 'auto' ? 'auto' : value);
    showSavedFeedback();
  }

  const sidebarBehaviors: { id: SidebarBehavior; label: string; desc: string }[] = [
    { id: 'auto',         label: m.us_sidebar_auto(), desc: m.us_sidebar_auto_desc() },
    { id: 'always-open',  label: m.us_sidebar_open(), desc: m.us_sidebar_open_desc() },
    { id: 'always-closed',label: m.us_sidebar_closed(), desc: m.us_sidebar_closed_desc() },
  ];
</script>

<div class="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700 pb-12">

  <!-- Header -->
  <header class="relative overflow-hidden flex flex-col md:flex-row md:items-center gap-4 bg-surface-container-low/40 p-5 rounded-xl border border-outline-variant/30">
    <div class="relative flex items-center gap-4 flex-1">
      <div class="relative shrink-0">
        <div class="relative w-11 h-11 rounded-lg border border-white/20 shadow-sm overflow-hidden">
          <img src={getUserAvatar()} alt="Avatar" class="w-full h-full object-cover" />
        </div>
      </div>
      <div>
        <h1 class="text-lg font-semibold tracking-tight leading-tight">{m.us_title()}</h1>
        <p class="text-sm text-on-surface-variant/70 font-medium">
          {m.us_subtitle()}
          {#if authStore.user?.username}
            · <span class="text-primary font-bold">{authStore.user.username}</span>
          {/if}
        </p>
      </div>
    </div>

    <!-- Save feedback badge -->
    {#if activeTab === 'preferences'}
      <div class="relative shrink-0">
        <div class="flex items-center gap-2 px-5 py-2.5 rounded-lg font-bold text-sm transition-all duration-500 {savedFeedback ? 'bg-emerald-500/20 border border-emerald-500/40 text-emerald-400' : 'bg-surface-container-high/30 border border-outline-variant/20 text-on-surface-variant/50'}">
          {#if savedFeedback}
            <Papicon icon="check" size={16} />
            {m.us_saved_auto()}
          {:else}
            <Papicon icon="Gears" size={16} />
            {m.us_autosave()}
          {/if}
        </div>
      </div>
    {/if}
  </header>

  <!-- ─── Onglets ───────────────────────────────────────────────── -->
  <div class="flex justify-center">
    <div class="flex gap-1 bg-surface-container-lowest/80 p-1.5 rounded-xl border border-outline-variant/10 shadow-sm shadow-surface/10 overflow-x-auto no-scrollbar">
      {#each tabs as tab}
        <button
          onclick={() => gotoTab(SETTINGS_BASE, tab.id, 'preferences')}
          class="tab-button {activeTab === tab.id ? 'active' : ''}"
        >
          <span class="flex items-center gap-2 pointer-events-none">
            <Papicon icon={tab.icon} size={16} class={activeTab === tab.id ? 'text-on-primary' : 'text-primary'} />
            {tab.label}
          </span>
        </button>
      {/each}
    </div>
  </div>

{#if activeTab === 'widget'}
  <ProfileWidgetPanel />
{:else}

  <section class="bg-surface-container-low/30 border border-outline-variant/10 p-6 rounded-xl space-y-5">
    <div class="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
      <div>
        <p class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest">{m.us_quick_overview()}</p>
        <h2 class="text-lg font-semibold mt-1">{m.us_active_settings()}</h2>
      </div>
      <div class="flex flex-wrap gap-2">
        <button onclick={openImportDialog} class="px-4 py-2 rounded-xl border border-outline-variant/20 bg-surface-container-high/20 text-sm font-bold hover:border-primary/30 hover:bg-primary/5 transition-colors">
          {m.common_import()}
        </button>
        <button onclick={exportPreferences} class="px-4 py-2 rounded-xl border border-outline-variant/20 bg-surface-container-high/20 text-sm font-bold hover:border-primary/30 hover:bg-primary/5 transition-colors">
          {m.common_export()}
        </button>
        <button onclick={testNotifications} class="px-4 py-2 rounded-xl border border-outline-variant/20 bg-surface-container-high/20 text-sm font-bold hover:border-primary/30 hover:bg-primary/5 transition-colors">
          {m.us_test_notifications()}
        </button>
        <button
          onclick={() => window.dispatchEvent(new CustomEvent('open-keyboard-shortcuts'))}
          class="px-4 py-2 rounded-xl border border-outline-variant/20 bg-surface-container-high/20 text-sm font-bold hover:border-primary/30 hover:bg-primary/5 transition-colors flex items-center gap-2"
        >
          <Papicon icon="Keyboard" size={14} />
          {m.us_keyboard_shortcuts()}
        </button>
      </div>
    </div>

    <div class="grid grid-cols-2 md:grid-cols-5 gap-3">
      {#each activeSummary as item}
        <div class="rounded-lg border border-outline-variant/20 bg-surface-container-high/20 p-4">
          <p class="text-[10px] font-bold text-on-surface-variant/50 uppercase tracking-widest">{item.label}</p>
          <p class="mt-2 text-sm font-semibold text-on-surface truncate">{item.value}</p>
        </div>
      {/each}
    </div>

    <input
      bind:this={importInput}
      type="file"
      accept="application/json"
      class="hidden"
      onchange={handleImportFile}
    />
  </section>

  <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">

    <!-- ─── Apparence ─────────────────────────────────────────── -->
    <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-8">
      <h2 class="text-xl font-semibold flex items-center gap-3">
        <div class="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center">
          <Papicon icon="Palette" size={16} class="text-primary" />
        </div>
        {m.us_appearance()}
      </h2>

      <!-- Theme Presets -->
      <div class="space-y-3">
        <p class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest">{m.us_theme()}</p>
        <div class="grid grid-cols-3 gap-2.5">
          {#each THEME_PRESETS as preset}
            <button
              onclick={() => handleToggle('theme', preset.id)}
              class="group relative flex flex-col items-center gap-2 p-3 rounded-lg border-2 transition-all duration-200 text-xs font-bold
 {themeStore.themeId === preset.id
                  ? 'border-primary bg-primary/10 text-primary shadow-sm shadow-primary/20'
                  : 'border-outline-variant/20 bg-surface-container-high/20 text-on-surface-variant hover:border-primary/30 hover:bg-primary/5'}"
            >
              <div class="w-full h-8 rounded-md overflow-hidden flex border border-outline-variant/20">
                <div class="flex-1" style="background:{preset.preview.bg}"></div>
                <div class="flex-1" style="background:{preset.preview.surface}"></div>
                <div class="w-2.5 rounded-r-sm" style="background:{preset.preview.text}; opacity:0.3"></div>
              </div>
              <span class="truncate w-full text-center">{preset.label}</span>
            </button>
          {/each}
          <!-- Custom theme button -->
          <button
            onclick={() => { handleToggle('theme', 'custom'); showCustomEditor = true; }}
            class="group relative flex flex-col items-center gap-2 p-3 rounded-lg border-2 transition-all duration-200 text-xs font-bold
 {themeStore.themeId === 'custom'
                ? 'border-primary bg-primary/10 text-primary shadow-sm shadow-primary/20'
                : 'border-outline-variant/20 bg-surface-container-high/20 text-on-surface-variant hover:border-primary/30 hover:bg-primary/5'}"
          >
            <div class="w-full h-8 rounded-md overflow-hidden flex items-center justify-center border border-dashed border-outline-variant/40 bg-surface-container-high/30">
              <Papicon icon="Palette" size={16} class="opacity-60" />
            </div>
            <span>Custom</span>
          </button>
        </div>
      </div>

      <!-- Custom Theme Editor -->
      {#if themeStore.themeId === 'custom' || showCustomEditor}
        <div class="space-y-4 p-4 rounded-lg border border-primary/20 bg-primary/5 animate-in fade-in duration-200">
          <div class="flex items-center justify-between">
            <p class="text-xs font-bold text-primary">{m.us_custom_theme()}</p>
            <button
              onclick={() => showCustomEditor = false}
              class="text-on-surface-variant/40 hover:text-on-surface transition-colors"
            >
              <Papicon icon="x" size={14} />
            </button>
          </div>

          <div class="flex items-center gap-3 p-3 rounded-lg bg-surface-container-high/20 border border-outline-variant/10">
            <span class="text-xs font-bold w-16 shrink-0">{m.us_mode()}</span>
            <div class="flex gap-2 flex-1">
              <button
                onclick={() => { customColors.mode = 'dark'; applyCustomTheme(); }}
                class="flex-1 py-1.5 rounded-md text-xs font-bold transition-all {customColors.mode === 'dark' ? 'bg-primary text-on-primary' : 'bg-surface-container-high/40 text-on-surface-variant hover:bg-surface-container-high'}"
              >{m.us_dark()}</button>
              <button
                onclick={() => { customColors.mode = 'light'; applyCustomTheme(); }}
                class="flex-1 py-1.5 rounded-md text-xs font-bold transition-all {customColors.mode === 'light' ? 'bg-primary text-on-primary' : 'bg-surface-container-high/40 text-on-surface-variant hover:bg-surface-container-high'}"
              >{m.us_light()}</button>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3">
            {#each [
              { key: 'background', label: m.us_color_background() },
              { key: 'surface', label: m.us_color_surface() },
              { key: 'text', label: m.us_color_text() },
              { key: 'surfaceContainer', label: m.us_color_panel() },
            ] as field}
              <label class="flex items-center gap-2.5 p-2.5 rounded-lg bg-surface-container-high/20 border border-outline-variant/10 cursor-pointer">
                <input
                  type="color"
                  value={customColors[field.key as keyof CustomThemeColors] as string}
                  oninput={(e) => { customColors[field.key as keyof CustomThemeColors] = (e.currentTarget as HTMLInputElement).value as any; }}
                  class="w-7 h-7 rounded-md border border-outline-variant/30 cursor-pointer shrink-0 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-md [&::-webkit-color-swatch]:border-none"
                />
                <span class="text-xs font-bold truncate">{field.label}</span>
              </label>
            {/each}
          </div>
          <p class="text-[10px] text-on-surface-variant/40">{m.us_accent_note()}</p>

          <!-- Preview -->
          <div class="rounded-lg overflow-hidden border border-outline-variant/20">
            <div class="flex h-14" style="background:{customColors.background}">
              <div class="w-10 flex items-center justify-center" style="background:{customColors.surfaceContainer}">
                <div class="w-4 h-4 rounded-sm bg-primary"></div>
              </div>
              <div class="flex-1 p-2.5 flex flex-col justify-center gap-1">
                <div class="h-2 w-20 rounded-full" style="background:{customColors.text}; opacity:0.8"></div>
                <div class="h-1.5 w-32 rounded-full" style="background:{customColors.text}; opacity:0.3"></div>
              </div>
              <div class="w-16 flex items-center justify-center">
                <div class="h-5 w-12 rounded-md bg-primary"></div>
              </div>
            </div>
          </div>

          <button
            onclick={applyCustomTheme}
            class="w-full py-2.5 rounded-lg bg-primary text-on-primary text-[13px] font-medium hover:brightness-110 transition-all"
          >
            {m.us_apply()}
          </button>
        </div>
      {/if}

      <!-- Accent Color -->
      <div class="space-y-3">
        <p class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest">{m.us_accent_color()}</p>
        <div class="flex flex-wrap gap-3">
          {#each accentColors as color}
            <button
              onclick={() => handleToggle('accentColor', color.id)}
              title={color.label}
              class="relative w-10 h-10 rounded-xl transition-all duration-200 {userPrefs.prefs.accentColor === color.id ? 'ring-2 ring-offset-2 ring-offset-surface-container-low scale-110' : ''}"
              style="background-color: {color.hex}; {userPrefs.prefs.accentColor === color.id ? `--tw-ring-color: ${color.hex}` : ''}"
            >
              {#if userPrefs.prefs.accentColor === color.id}
                <div class="absolute inset-0 flex items-center justify-center">
                  <Papicon icon="check" size={16} class="text-white" />
                </div>
              {/if}
            </button>
          {/each}
        </div>
      </div>

      <!-- Compact Mode -->
      <div class="flex items-center justify-between p-4 rounded-lg bg-surface-container-high/20 border border-outline-variant/5 hover:bg-surface-container-high/40 transition-colors">
        <div>
          <p class="text-sm font-bold">{m.us_compact_mode()}</p>
          <p class="text-[10px] text-on-surface-variant/50">{m.us_compact_mode_desc()}</p>
        </div>
        <ToggleSwitch
          checked={userPrefs.prefs.compactMode}
          onToggle={(v: boolean) => handleToggle('compactMode', v)}
        />
      </div>

      <!-- Animations -->
      <div class="flex items-center justify-between p-4 rounded-lg bg-surface-container-high/20 border border-outline-variant/5 hover:bg-surface-container-high/40 transition-colors">
        <div>
          <p class="text-sm font-bold">{m.us_animations()}</p>
          <p class="text-[10px] text-on-surface-variant/50">{m.us_animations_desc()}</p>
        </div>
        <ToggleSwitch
          checked={userPrefs.prefs.animationsEnabled}
          onToggle={(v: boolean) => handleToggle('animationsEnabled', v)}
        />
      </div>
    </section>

    <!-- ─── Langue & Dates ────────────────────────────────────── -->
    <div class="space-y-8">
      <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-8">
        <h2 class="text-xl font-semibold flex items-center gap-3">
          <div class="w-8 h-8 rounded-xl bg-secondary/10 flex items-center justify-center">
            <Papicon icon="Globe" size={16} class="text-secondary" />
          </div>
          {m.us_language_region()}
        </h2>

        <!-- Language -->
        <div class="space-y-3">
          <p class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest">{m.us_interface_language()}</p>
          <div class="grid grid-cols-2 gap-3">
            {#each languages as lang}
              <button
                onclick={() => handleToggle('language', lang.id)}
                class="flex items-center gap-3 p-4 rounded-lg border-2 transition-all duration-200 font-bold text-sm
 {userPrefs.prefs.language === lang.id
                    ? 'border-secondary bg-secondary/10 text-secondary'
                    : 'border-outline-variant/20 bg-surface-container-high/20 text-on-surface-variant hover:border-secondary/40'}"
              >
                <span class="text-xl">{lang.flag}</span>
                {lang.label}
              </button>
            {/each}
          </div>
        </div>

        <!-- Date format -->
        <div class="space-y-3">
          <p class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest">{m.us_date_format()}</p>
          <div class="space-y-2">
            {#each dateFormats as fmt}
              <button
                onclick={() => handleToggle('dateFormat', fmt.id)}
                class="w-full flex items-center gap-4 p-3.5 rounded-xl border transition-all duration-200 text-left
 {userPrefs.prefs.dateFormat === fmt.id
                    ? 'border-secondary/40 bg-secondary/8 text-on-surface'
                    : 'border-outline-variant/10 bg-surface-container-high/10 text-on-surface-variant hover:border-secondary/20'}"
              >
                <div class="w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center
 {userPrefs.prefs.dateFormat === fmt.id ? 'border-secondary' : 'border-outline-variant/40'}">
                  {#if userPrefs.prefs.dateFormat === fmt.id}
                    <div class="w-2 h-2 rounded-full bg-secondary"></div>
                  {/if}
                </div>
                <div>
                  <p class="text-sm font-bold">{fmt.label}</p>
                  <p class="text-[10px] text-on-surface-variant/50">{fmt.example}</p>
                </div>
              </button>
            {/each}
          </div>
        </div>

        <!-- Fuseau horaire des statistiques -->
        <div class="space-y-3">
          <p class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest">{m.us_timezone()}</p>
          <select
            value={timezoneChoice}
            onchange={(e) => handleTimezone((e.currentTarget as HTMLSelectElement).value)}
            class="w-full bg-surface-container-high/20 border border-outline-variant/20 rounded-xl px-4 py-3 text-sm text-on-surface outline-none focus:border-secondary transition-colors"
          >
            <option value="auto">{m.us_timezone_auto({ zone: timezoneStore.browserTimezone })}</option>
            {#each timezoneZones as zone}
              <option value={zone}>{zone.replace(/_/g, ' ')}</option>
            {/each}
          </select>
          <p class="text-[10px] text-on-surface-variant/50">
            {m.us_timezone_desc({ zone: timezoneStore.displayTimezone })}
          </p>
        </div>
      </section>
    </div>

    <!-- ─── Sidebar ───────────────────────────────────────────── -->
    <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-8">
      <h2 class="text-xl font-semibold flex items-center gap-3">
        <div class="w-8 h-8 rounded-xl bg-tertiary/10 flex items-center justify-center">
          <Papicon icon="Menu" size={16} class="text-tertiary" />
        </div>
        {m.us_navigation()}
      </h2>

      <!-- Sidebar behavior -->
      <div class="space-y-3">
        <p class="text-[10px] font-bold text-on-surface-variant/60 uppercase tracking-widest">{m.us_sidebar_behavior()}</p>
        <div class="space-y-2">
          {#each sidebarBehaviors as behavior}
            <button
              onclick={() => handleToggle('sidebarBehavior', behavior.id)}
              class="w-full flex items-center gap-4 p-3.5 rounded-xl border transition-all duration-200 text-left
 {userPrefs.prefs.sidebarBehavior === behavior.id
                  ? 'border-tertiary/40 bg-tertiary/8 text-on-surface'
                  : 'border-outline-variant/10 bg-surface-container-high/10 text-on-surface-variant hover:border-tertiary/20'}"
            >
              <div class="w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center
 {userPrefs.prefs.sidebarBehavior === behavior.id ? 'border-tertiary' : 'border-outline-variant/40'}">
                {#if userPrefs.prefs.sidebarBehavior === behavior.id}
                  <div class="w-2 h-2 rounded-full bg-tertiary"></div>
                {/if}
              </div>
              <div>
                <p class="text-sm font-bold">{behavior.label}</p>
                <p class="text-[10px] text-on-surface-variant/50">{behavior.desc}</p>
              </div>
            </button>
          {/each}
        </div>
      </div>
    </section>

    <!-- ─── Notifications & Confidentialité ──────────────────── -->
    <section class="bg-surface-container-low/30 border border-outline-variant/10 p-8 rounded-xl space-y-8">
      <h2 class="text-xl font-semibold flex items-center gap-3">
        <div class="w-8 h-8 rounded-xl bg-rose-500/10 flex items-center justify-center">
          <Papicon icon="Bell" size={16} class="text-rose-500" />
        </div>
        {m.us_notif_privacy()}
      </h2>

      <div class="space-y-3">
        {#each [
          { key: 'soundNotifications', label: m.us_sound_notif(), desc: m.us_sound_notif_desc(), color: 'rose' },
          { key: 'desktopNotifications', label: m.us_desktop_notif(), desc: m.us_desktop_notif_desc(), color: 'rose' },
          { key: 'showOnlineStatus', label: m.us_online_status(), desc: m.us_online_status_desc(), color: 'rose' },
        ] as item}
          <div class="flex items-center justify-between p-4 rounded-lg bg-surface-container-high/20 border border-outline-variant/5 hover:bg-surface-container-high/40 transition-colors">
            <div>
              <p class="text-sm font-bold">{item.label}</p>
              <p class="text-[10px] text-on-surface-variant/50">{item.desc}</p>
            </div>
            <ToggleSwitch
              checked={(userPrefs.prefs as any)[item.key]}
              onToggle={(v: boolean) => handleToggle(item.key as any, v)}
            />
          </div>
        {/each}
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
        <a href="https://kotbo.fr/terms" target="_blank" rel="noopener noreferrer" class="p-4 rounded-lg border border-outline-variant/10 bg-surface-container-high/20 hover:bg-surface-container-high/40 transition-colors">
          <p class="text-sm font-bold">{m.us_privacy_policy()}</p>
          <p class="text-[10px] text-on-surface-variant/50 mt-1">{m.us_privacy_policy_desc()}</p>
        </a>
        <a href="https://kotbo.fr/cookies" target="_blank" rel="noopener noreferrer" class="p-4 rounded-lg border border-outline-variant/10 bg-surface-container-high/20 hover:bg-surface-container-high/40 transition-colors">
          <p class="text-sm font-bold">{m.us_cookies()}</p>
          <p class="text-[10px] text-on-surface-variant/50 mt-1">{m.us_cookies_desc()}</p>
        </a>
        <a href="mailto:privacy@kotbo.fr?subject=Demande%20RGPD%20Kotbo" class="sm:col-span-2 p-4 rounded-lg border border-primary/20 bg-primary/5 hover:bg-primary/10 transition-colors">
          <p class="text-sm font-bold text-primary">{m.us_gdpr_rights()}</p>
          <p class="text-[10px] text-on-surface-variant/60 mt-1">{m.us_gdpr_rights_desc()}</p>
        </a>
      </div>
    </section>
  </div>

  <!-- ─── Danger Zone ───────────────────────────────────────────── -->
  <section class="bg-rose-500/5 border border-rose-500/20 p-8 rounded-xl space-y-4">
    <h2 class="text-xl font-semibold text-rose-500 flex items-center gap-3">
      <Papicon icon="AlertTriangle" size={20} />
      {m.us_reset_zone()}
    </h2>
    <p class="text-sm text-on-surface-variant/70">
      {m.us_reset_desc()}
    </p>
    <button
      onclick={() => { userPrefs.reset(); themeStore.themeId = userPrefs.prefs.theme; showSavedFeedback(); toast.success(m.us_reset_done()); }}
      class="px-6 py-2.5 rounded-xl border-2 border-rose-500/40 text-rose-500 font-bold text-sm hover:bg-rose-500/10 transition-all duration-200 hover:border-rose-500/60"
    >
      {m.us_reset_button()}
    </button>
  </section>
{/if}
</div>
