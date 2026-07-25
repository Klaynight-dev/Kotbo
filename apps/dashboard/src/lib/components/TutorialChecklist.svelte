<script lang="ts">
  import {
    onboardingStore, checklistTasks, setupTasks,
    essentialSetupTasks, optionalSetupTasks,
    type GuideTab,
  } from '../stores/tutorial.svelte';
  import { fly, scale } from 'svelte/transition';
  import { cubicOut, backOut } from 'svelte/easing';
  import { router } from 'tinro';
  import {
    CheckCircle, ChevronDown, ChevronUp, X, Sparkles, Rocket,
    LayoutGrid, Package, Users, Shield, Trophy, UserCheck, Settings, Keyboard,
    PartyPopper, Compass, Wrench,
    Book, Hash, ShieldAlert, Megaphone, Coins, MessageSquare, MousePointer,
    ThumbsUp, FilePlus, FileText, UserPlus, Rss, Code, Smile, Share2,
    Calendar, Archive,
  } from 'lucide-svelte';
  import { m } from '../i18n';

  const iconMap: Record<string, typeof LayoutGrid> = {
    'layout-grid': LayoutGrid,
    'package': Package,
    'users': Users,
    'shield': Shield,
    'trophy': Trophy,
    'user-check': UserCheck,
    'settings': Settings,
    'keyboard': Keyboard,
    'book': Book,
    'hash': Hash,
    'shield-alert': ShieldAlert,
    'megaphone': Megaphone,
    'coins': Coins,
    'message-square': MessageSquare,
    'mouse-pointer': MousePointer,
    'thumbs-up': ThumbsUp,
    'file-plus': FilePlus,
    'file-text': FileText,
    'user-plus': UserPlus,
    'rss': Rss,
    'code': Code,
    'smile': Smile,
    'share-2': Share2,
    'calendar': Calendar,
    'archive': Archive,
    'sparkles': Sparkles,
  };

  let show = $derived(
    onboardingStore.initialized
    && !onboardingStore.checklistDismissed
    && onboardingStore.welcomeSeen
  );

  let minimized = $derived(onboardingStore.checklistMinimized);
  let activeTab = $derived(onboardingStore.activeTab);

  // Discover stats
  let discoverCompleted = $derived(onboardingStore.completedCount);
  let discoverTotal = $derived(onboardingStore.totalTasks);
  let discoverProgress = $derived(onboardingStore.progress);
  let discoverDone = $derived(onboardingStore.allCompleted);

  // Setup stats
  let setupCompletedCount = $derived(onboardingStore.completedSetupCount);
  let setupTotal = $derived(onboardingStore.totalSetupTasks);
  let setupProgress = $derived(onboardingStore.setupProgress);
  let setupDone = $derived(onboardingStore.allSetupCompleted);
  let essentialsDone = $derived(onboardingStore.essentialsDone);
  let essentialTotal = $derived(onboardingStore.essentialSetupCount);
  let essentialCompleted = $derived(onboardingStore.completedEssentialCount);

  // Overall
  let overallProgress = $derived(onboardingStore.overallProgress);
  let bothDone = $derived(onboardingStore.bothCompleted);

  // Current tab active progress for the FAB
  let fabProgress = $derived(activeTab === 'discover' ? discoverProgress : setupProgress);
  let fabRemaining = $derived(
    activeTab === 'discover'
      ? discoverTotal - discoverCompleted
      : setupTotal - setupCompletedCount
  );

  // Optional section collapsed
  let optionalCollapsed = $state(true);

  function navigateTo(route: string) {
    router.goto(route);
  }

  function setTab(tab: GuideTab) {
    onboardingStore.setActiveTab(tab);
  }

  function toggleMinimize() {
    onboardingStore.toggleChecklist();
  }

  function dismiss() {
    onboardingStore.dismissChecklist();
  }
</script>

{#if show}
  <div
    class="fixed bottom-6 right-6 z-[9990] flex flex-col items-end"
    transition:fly={{ y: 30, duration: 350, easing: cubicOut }}
  >
    {#if !minimized}
      <!-- Expanded panel -->
      <div
        class="w-[22rem] bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-xl overflow-hidden"
        transition:scale={{ duration: 250, easing: backOut, start: 0.92 }}
      >
        <!-- Header -->
        <div class="bg-gradient-to-r from-primary/8 to-secondary/8 border-b border-outline-variant">
          <div class="flex items-center justify-between px-4 pt-3 pb-2">
            <div class="flex items-center gap-2.5">
              <div class="w-8 h-8 rounded-lg bg-primary/15 flex items-center justify-center">
                {#if bothDone}
                  <PartyPopper class="w-4 h-4 text-primary" />
                {:else}
                  <Rocket class="w-4 h-4 text-primary" />
                {/if}
              </div>
              <div>
                <h3 class="text-sm font-semibold text-on-surface leading-none">{m.d4_tc_title()}</h3>
                <p class="text-[11px] text-on-surface-variant mt-0.5">{m.d4_tc_percent_complete({ pct: overallProgress })}</p>
              </div>
            </div>

            <div class="flex items-center gap-1">
              <button
                onclick={toggleMinimize}
                class="p-1.5 rounded-lg hover:bg-surface-container text-on-surface-variant hover:text-on-surface transition-colors"
                aria-label={m.d4_minimize()}
              >
                <ChevronDown class="w-4 h-4" />
              </button>
              <button
                onclick={dismiss}
                class="p-1.5 rounded-lg hover:bg-surface-container text-on-surface-variant hover:text-on-surface transition-colors"
                aria-label={m.d4_dismiss_permanently()}
              >
                <X class="w-4 h-4" />
              </button>
            </div>
          </div>

          <!-- Tabs -->
          <div class="flex px-3 pb-0 gap-1">
            <button
              onclick={() => setTab('discover')}
              class="
 flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t-lg
                border-b-2 transition-colors
                {activeTab === 'discover'
                  ? 'border-primary text-primary bg-primary/5'
                  : 'border-transparent text-on-surface-variant hover:text-on-surface hover:bg-surface-container/50'}
              "
            >
              <Compass class="w-3.5 h-3.5" />
              {m.d4_tc_tab_discover()}
              {#if !discoverDone}
                <span class="px-1.5 py-0.5 rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                  {discoverCompleted}/{discoverTotal}
                </span>
              {:else}
                <CheckCircle class="w-3 h-3 text-emerald-500" />
              {/if}
            </button>
            <button
              onclick={() => setTab('setup')}
              class="
 flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t-lg
                border-b-2 transition-colors
                {activeTab === 'setup'
                  ? 'border-primary text-primary bg-primary/5'
                  : 'border-transparent text-on-surface-variant hover:text-on-surface hover:bg-surface-container/50'}
              "
            >
              <Wrench class="w-3.5 h-3.5" />
              {m.d4_tc_tab_setup()}
              {#if !setupDone}
                <span class="px-1.5 py-0.5 rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                  {setupCompletedCount}/{setupTotal}
                </span>
              {:else}
                <CheckCircle class="w-3 h-3 text-emerald-500" />
              {/if}
            </button>
          </div>
        </div>

        <!-- Task list -->
        <div class="max-h-80 overflow-y-auto overscroll-contain">

          <!-- ═══ DISCOVER TAB ═══ -->
          {#if activeTab === 'discover'}
            {#if discoverDone}
              <div class="p-5 text-center" in:fly={{ y: 10, duration: 300, easing: cubicOut }}>
                <div class="w-14 h-14 mx-auto mb-3 rounded-2xl bg-emerald-500/10 flex items-center justify-center">
                  <PartyPopper class="w-7 h-7 text-emerald-500" />
                </div>
                <p class="text-sm font-semibold text-on-surface mb-1">{m.d4_tc_discover_done_title()}</p>
                <p class="text-xs text-on-surface-variant mb-4">{m.d4_tc_discover_done_desc()}</p>
                <button
                  onclick={() => setTab('setup')}
                  class="px-4 py-2 rounded-lg bg-primary/10 text-primary text-xs font-medium hover:bg-primary/15 transition-colors"
                >
                  {m.d4_tc_go_to_setup()}
                </button>
              </div>
            {:else}
              <div class="p-2">
                {#each checklistTasks as task (task.id)}
                  {@const completed = onboardingStore.isTaskCompleted(task.id)}
                  {@const Icon = iconMap[task.icon] || Sparkles}
                  <button
                    type="button"
                    onclick={() => { if (task.route && !completed) navigateTo(task.route); }}
                    class="
 w-full flex items-start gap-3 p-2.5 rounded-xl text-left
                      transition-all duration-150 group
                      {completed ? 'opacity-60' : 'hover:bg-surface-container cursor-pointer'}
                    "
                    disabled={completed && !task.route}
                  >
                    <div class="mt-0.5 shrink-0">
                      {#if completed}
                        <div class="w-5 h-5 rounded-full bg-emerald-500 flex items-center justify-center"
                          in:scale={{ duration: 300, easing: backOut, start: 0.5 }}>
                          <CheckCircle class="w-3.5 h-3.5 text-white" />
                        </div>
                      {:else}
                        <div class="w-5 h-5 rounded-full border-2 border-outline-variant group-hover:border-primary transition-colors"></div>
                      {/if}
                    </div>
                    <div class="flex-1 min-w-0">
                      <p class="text-[13px] font-medium text-on-surface leading-tight {completed ? 'line-through text-on-surface-variant' : ''}">{task.title}</p>
                      <p class="text-[11px] text-on-surface-variant/70 mt-0.5 leading-relaxed">{task.description}</p>
                    </div>
                    <div class="shrink-0 mt-0.5">
                      <div class="w-7 h-7 rounded-lg {completed ? 'bg-surface-container' : 'bg-primary/8 group-hover:bg-primary/12'} flex items-center justify-center transition-colors">
                        <Icon class="w-3.5 h-3.5 {completed ? 'text-on-surface-variant/50' : 'text-primary'}" />
                      </div>
                    </div>
                  </button>
                {/each}
              </div>
            {/if}

          <!-- ═══ SETUP TAB ═══ -->
          {:else}
            {#if setupDone}
              <div class="p-5 text-center" in:fly={{ y: 10, duration: 300, easing: cubicOut }}>
                <div class="w-14 h-14 mx-auto mb-3 rounded-2xl bg-emerald-500/10 flex items-center justify-center">
                  <PartyPopper class="w-7 h-7 text-emerald-500" />
                </div>
                <p class="text-sm font-semibold text-on-surface mb-1">{m.d4_tc_setup_done_title()}</p>
                <p class="text-xs text-on-surface-variant mb-4">{m.d4_tc_setup_done_desc()}</p>
                <button onclick={dismiss} class="px-4 py-2 rounded-lg bg-primary/10 text-primary text-xs font-medium hover:bg-primary/15 transition-colors">
                  {m.d4_tc_close_guide()}
                </button>
              </div>
            {:else}
              <div class="p-2">
                <!-- Essential section -->
                <div class="px-2.5 pt-2 pb-1">
                  <div class="flex items-center gap-2">
                    <span class="text-xs font-medium text-amber-600 dark:text-amber-400">
                      {m.d4_tc_essential()}
                    </span>
                    <span class="text-[10px] text-on-surface-variant">
                      {essentialCompleted} / {essentialTotal}
                    </span>
                    {#if essentialsDone}
                      <CheckCircle class="w-3 h-3 text-emerald-500" />
                    {/if}
                  </div>
                  <div class="mt-1 h-1 bg-surface-container-high rounded-full overflow-hidden">
                    <div
                      class="h-full bg-gradient-to-r from-amber-500 to-amber-400 rounded-full transition-all duration-500"
                      style="width: {essentialTotal === 0 ? 100 : (essentialCompleted / essentialTotal) * 100}%"
                    ></div>
                  </div>
                </div>

                {#each essentialSetupTasks as task (task.id)}
                  {@const completed = onboardingStore.isSetupTaskCompleted(task.id)}
                  {@const Icon = iconMap[task.icon] || Sparkles}
                  <button
                    type="button"
                    onclick={() => { if (!completed) navigateTo(task.route); }}
                    class="
 w-full flex items-start gap-3 p-2.5 rounded-xl text-left
                      transition-all duration-150 group
                      {completed ? 'opacity-60' : 'hover:bg-surface-container cursor-pointer'}
                    "
                  >
                    <div class="mt-0.5 shrink-0">
                      {#if completed}
                        <div class="w-5 h-5 rounded-full bg-emerald-500 flex items-center justify-center"
                          in:scale={{ duration: 300, easing: backOut, start: 0.5 }}>
                          <CheckCircle class="w-3.5 h-3.5 text-white" />
                        </div>
                      {:else}
                        <div class="w-5 h-5 rounded-full border-2 border-amber-400 group-hover:border-amber-500 transition-colors"></div>
                      {/if}
                    </div>
                    <div class="flex-1 min-w-0">
                      <p class="text-[13px] font-medium text-on-surface leading-tight {completed ? 'line-through text-on-surface-variant' : ''}">{task.title}</p>
                      <p class="text-[11px] text-on-surface-variant/70 mt-0.5 leading-relaxed">{task.description}</p>
                    </div>
                    <div class="shrink-0 mt-0.5">
                      <div class="w-7 h-7 rounded-lg {completed ? 'bg-surface-container' : 'bg-amber-500/10 group-hover:bg-amber-500/15'} flex items-center justify-center transition-colors">
                        <Icon class="w-3.5 h-3.5 {completed ? 'text-on-surface-variant/50' : 'text-amber-600 dark:text-amber-400'}" />
                      </div>
                    </div>
                  </button>
                {/each}

                <!-- Separator -->
                <div class="mx-2.5 my-2 border-t border-outline-variant"></div>

                <!-- Optional section header -->
                <button
                  type="button"
                  onclick={() => (optionalCollapsed = !optionalCollapsed)}
                  class="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg hover:bg-surface-container/50 transition-colors"
                >
                  <div class="flex items-center gap-2">
                    <span class="text-xs font-medium text-on-surface-variant">
                      {m.d4_tc_customization()}
                    </span>
                    <span class="text-[10px] text-on-surface-variant/60">
                      {optionalSetupTasks.filter(t => onboardingStore.isSetupTaskCompleted(t.id)).length} / {optionalSetupTasks.length}
                    </span>
                  </div>
                  <div class="transition-transform duration-200 {optionalCollapsed ? '-rotate-90' : ''}">
                    <ChevronDown class="w-3.5 h-3.5 text-on-surface-variant/40" />
                  </div>
                </button>

                {#if !optionalCollapsed}
                  {#each optionalSetupTasks as task (task.id)}
                    {@const completed = onboardingStore.isSetupTaskCompleted(task.id)}
                    {@const Icon = iconMap[task.icon] || Sparkles}
                    <button
                      type="button"
                      onclick={() => { if (!completed) navigateTo(task.route); }}
                      class="
 w-full flex items-start gap-3 p-2.5 rounded-xl text-left
                        transition-all duration-150 group
                        {completed ? 'opacity-60' : 'hover:bg-surface-container cursor-pointer'}
                      "
                    >
                      <div class="mt-0.5 shrink-0">
                        {#if completed}
                          <div class="w-5 h-5 rounded-full bg-emerald-500 flex items-center justify-center"
                            in:scale={{ duration: 300, easing: backOut, start: 0.5 }}>
                            <CheckCircle class="w-3.5 h-3.5 text-white" />
                          </div>
                        {:else}
                          <div class="w-5 h-5 rounded-full border-2 border-outline-variant group-hover:border-primary transition-colors"></div>
                        {/if}
                      </div>
                      <div class="flex-1 min-w-0">
                        <p class="text-[13px] font-medium text-on-surface leading-tight {completed ? 'line-through text-on-surface-variant' : ''}">{task.title}</p>
                        <p class="text-[11px] text-on-surface-variant/70 mt-0.5 leading-relaxed">{task.description}</p>
                      </div>
                      <div class="shrink-0 mt-0.5">
                        <div class="w-7 h-7 rounded-lg {completed ? 'bg-surface-container' : 'bg-primary/8 group-hover:bg-primary/12'} flex items-center justify-center transition-colors">
                          <Icon class="w-3.5 h-3.5 {completed ? 'text-on-surface-variant/50' : 'text-primary'}" />
                        </div>
                      </div>
                    </button>
                  {/each}
                {/if}
              </div>
            {/if}
          {/if}

        </div>

        <!-- Footer progress -->
        <div class="border-t border-outline-variant px-4 py-2">
          <div class="h-1.5 bg-surface-container-high rounded-full overflow-hidden">
            <div
              class="h-full bg-gradient-to-r from-primary to-secondary rounded-full transition-all duration-700 ease-out"
              style="width: {overallProgress}%"
            ></div>
          </div>
          <p class="text-[10px] text-on-surface-variant/60 mt-1 text-center">
            {m.d4_tc_global_progress({ pct: overallProgress })}
          </p>
        </div>
      </div>

    {:else}
      <!-- Minimized FAB -->
      <button
        onclick={toggleMinimize}
        class="
 group flex items-center gap-2.5 px-4 py-2.5 rounded-2xl
          bg-surface-container-lowest border border-outline-variant
          shadow-lg hover:shadow-xl
          transition-all duration-200
          hover:border-primary/30
        "
        transition:scale={{ duration: 250, easing: backOut, start: 0.85 }}
        aria-label={m.d4_tc_open_guide()}
      >
        <div class="relative">
          <div class="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center group-hover:bg-primary/15 transition-colors">
            <Rocket class="w-4 h-4 text-primary" />
          </div>
          {#if !bothDone}
            <div class="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-primary text-[9px] text-on-primary font-bold flex items-center justify-center">
              {fabRemaining}
            </div>
          {/if}
        </div>

        <div class="hidden sm:block text-left">
          <p class="text-xs font-semibold text-on-surface leading-none">{m.d4_tc_guide()}</p>
          <div class="flex items-center gap-2 mt-1">
            <div class="w-16 h-1 bg-surface-container-high rounded-full overflow-hidden">
              <div
                class="h-full bg-gradient-to-r from-primary to-secondary rounded-full transition-all duration-500"
                style="width: {overallProgress}%"
              ></div>
            </div>
            <span class="text-[10px] text-on-surface-variant">{overallProgress}%</span>
          </div>
        </div>

        <ChevronUp class="w-3.5 h-3.5 text-on-surface-variant/50 group-hover:text-on-surface-variant transition-colors" />
      </button>
    {/if}
  </div>
{/if}

<style>
  .overscroll-contain {
    overscroll-behavior: contain;
  }
</style>
