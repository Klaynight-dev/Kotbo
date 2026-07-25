<script lang="ts">
  import { onboardingStore } from '../stores/tutorial.svelte';
  import { fade, fly, scale } from 'svelte/transition';
  import { cubicOut, backOut } from 'svelte/easing';
  import { Sparkles, ArrowRight, Rocket, Zap, Shield, LayoutGrid, Compass, Wrench } from 'lucide-svelte';
  import { m } from '../i18n';

  let show = $derived(onboardingStore.showWelcome);
  let step = $state(0);

  const features = [
    {
      icon: LayoutGrid,
      title: m.d1_tw_feature1_title(),
      description: m.d1_tw_feature1_desc(),
    },
    {
      icon: Shield,
      title: m.d1_tw_feature2_title(),
      description: m.d1_tw_feature2_desc(),
    },
    {
      icon: Zap,
      title: m.d1_tw_feature3_title(),
      description: m.d1_tw_feature3_desc(),
    },
  ];

  function getStarted() {
    onboardingStore.dismissWelcome();
  }
</script>

{#if show}
  <!-- Backdrop -->
  <div
    class="fixed inset-0 z-[10000] flex items-center justify-center p-4"
    transition:fade={{ duration: 200 }}
  >
    <div
      class="absolute inset-0 bg-black/60 backdrop-blur-sm"
      onclick={getStarted}
      role="presentation"
    ></div>

    <!-- Modal -->
    <div
      class="relative w-full max-w-lg bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-2xl overflow-hidden"
      transition:scale={{ duration: 400, easing: backOut, start: 0.9 }}
    >
      <!-- Gradient accent top -->
      <div class="h-1 bg-gradient-to-r from-primary via-secondary to-tertiary"></div>

      {#if step === 0}
        <!-- Step 1: Welcome -->
        <div
          class="p-8 text-center"
          in:fly={{ y: 20, duration: 300, delay: 100, easing: cubicOut }}
        >
          <!-- Animated icon -->
          <div class="relative mx-auto w-20 h-20 mb-6">
            <div class="absolute inset-0 bg-primary/10 rounded-2xl rotate-6 animate-pulse"></div>
            <div class="relative w-full h-full bg-gradient-to-br from-primary to-secondary rounded-2xl flex items-center justify-center shadow-sm">
              <Rocket class="w-10 h-10 text-on-primary" />
            </div>
          </div>

          <h1 class="text-2xl font-bold text-on-surface mb-2 tracking-tight">
            {m.d1_tw_welcome_title()}
          </h1>
          <p class="text-on-surface-variant text-sm leading-relaxed max-w-sm mx-auto mb-8">
            {m.d1_tw_welcome_desc()}
          </p>

          <!-- Feature cards -->
          <div class="space-y-3 mb-8">
            {#each features as feature, i}
              <div
                class="flex items-center gap-4 p-3 rounded-xl bg-surface-container border border-outline-variant text-left group hover:border-primary/30 transition-colors"
                in:fly={{ y: 15, duration: 250, delay: 200 + i * 80, easing: cubicOut }}
              >
                <div class="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0 group-hover:bg-primary/15 transition-colors">
                  <feature.icon class="w-5 h-5 text-primary" />
                </div>
                <div class="min-w-0">
                  <p class="text-sm font-semibold text-on-surface">{feature.title}</p>
                  <p class="text-xs text-on-surface-variant leading-relaxed">{feature.description}</p>
                </div>
              </div>
            {/each}
          </div>

          <button
            onclick={() => (step = 1)}
            class="w-full flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-primary to-secondary text-on-primary font-semibold text-sm hover:opacity-90 transition-opacity shadow-sm"
          >
            {m.d1_tw_continue()}
            <ArrowRight class="w-4 h-4" />
          </button>
        </div>

      {:else}
        <!-- Step 2: Two guides overview -->
        <div
          class="p-8"
          in:fly={{ x: 30, duration: 300, easing: cubicOut }}
        >
          <div class="text-center mb-6">
            <div class="mx-auto w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
              <Sparkles class="w-8 h-8 text-primary" />
            </div>
            <h2 class="text-xl font-bold text-on-surface mb-2 tracking-tight">
              {m.d1_tw_guides_title()}
            </h2>
            <p class="text-on-surface-variant text-sm leading-relaxed max-w-sm mx-auto">
              {m.d1_tw_guides_desc()}
            </p>
          </div>

          <!-- Two guide cards -->
          <div class="space-y-3 mb-8">
            <div
              class="flex items-start gap-3.5 p-4 rounded-xl bg-surface-container border border-outline-variant text-left"
              in:fly={{ y: 12, duration: 250, delay: 100, easing: cubicOut }}
            >
              <div class="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                <Compass class="w-5 h-5 text-primary" />
              </div>
              <div class="min-w-0">
                <p class="text-sm font-semibold text-on-surface mb-0.5">{m.d1_tw_discovery_title()}</p>
                <p class="text-xs text-on-surface-variant leading-relaxed">
                  {m.d1_tw_discovery_desc()}
                </p>
              </div>
            </div>

            <div
              class="flex items-start gap-3.5 p-4 rounded-xl bg-surface-container border border-amber-500/20 text-left"
              in:fly={{ y: 12, duration: 250, delay: 200, easing: cubicOut }}
            >
              <div class="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center shrink-0">
                <Wrench class="w-5 h-5 text-amber-600 dark:text-amber-400" />
              </div>
              <div class="min-w-0">
                <p class="text-sm font-semibold text-on-surface mb-0.5">{m.d1_tw_config_title()}</p>
                <p class="text-xs text-on-surface-variant leading-relaxed">
                  {m.d1_tw_config_desc()}
                </p>
              </div>
            </div>
          </div>

          <div class="flex gap-3">
            <button
              onclick={getStarted}
              class="flex-1 px-6 py-3 rounded-xl border border-outline-variant text-on-surface-variant font-medium text-sm hover:bg-surface-container transition-colors"
            >
              {m.d1_tw_skip()}
            </button>
            <button
              onclick={getStarted}
              class="flex-1 flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-primary to-secondary text-on-primary font-semibold text-sm hover:opacity-90 transition-opacity shadow-sm"
            >
              {m.d1_tw_lets_go()}
              <Rocket class="w-4 h-4" />
            </button>
          </div>
        </div>
      {/if}

      <!-- Step indicator -->
      <div class="flex justify-center gap-2 pb-6">
        <button
          onclick={() => (step = 0)}
          class="w-2 h-2 rounded-full transition-all duration-300 {step === 0 ? 'w-6 bg-primary' : 'bg-outline-variant hover:bg-outline'}"
          aria-label={m.d1_tw_step1()}
        ></button>
        <button
          onclick={() => (step = 1)}
          class="w-2 h-2 rounded-full transition-all duration-300 {step === 1 ? 'w-6 bg-primary' : 'bg-outline-variant hover:bg-outline'}"
          aria-label={m.d1_tw_step2()}
        ></button>
      </div>
    </div>
  </div>
{/if}
