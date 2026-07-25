<script lang="ts">
  import { m } from '../i18n';

  type HintSet = { delay: number; messages: string[] };

  let {
    context = 'default',
    class: className = '',
  }: {
    context?: 'data' | 'analytics' | 'network' | 'config' | 'members' | 'default';
    class?: string;
  } = $props();

  const hintSets: Record<string, HintSet[]> = {
    data: [
      { delay: 3000, messages: [
        m.d6_hint_data_3s_1(),
        m.d6_hint_data_3s_2(),
        m.d6_hint_data_3s_3(),
      ]},
      { delay: 8000, messages: [
        m.d6_hint_data_8s_1(),
        m.d6_hint_data_8s_2(),
        m.d6_hint_data_8s_3(),
      ]},
      { delay: 15000, messages: [
        m.d6_hint_data_15s_1(),
        m.d6_hint_data_15s_2(),
        m.d6_hint_data_15s_3(),
      ]},
      { delay: 25000, messages: [
        m.d6_hint_data_25s_1(),
        m.d6_hint_data_25s_2(),
      ]},
    ],
    analytics: [
      { delay: 3000, messages: [
        m.d6_hint_analytics_3s_1(),
        m.d6_hint_analytics_3s_2(),
        m.d6_hint_analytics_3s_3(),
      ]},
      { delay: 8000, messages: [
        m.d6_hint_analytics_8s_1(),
        m.d6_hint_analytics_8s_2(),
        m.d6_hint_analytics_8s_3(),
      ]},
      { delay: 15000, messages: [
        m.d6_hint_analytics_15s_1(),
        m.d6_hint_analytics_15s_2(),
      ]},
      { delay: 25000, messages: [
        m.d6_hint_analytics_25s_1(),
      ]},
    ],
    network: [
      { delay: 3000, messages: [
        m.d6_hint_network_3s_1(),
        m.d6_hint_network_3s_2(),
      ]},
      { delay: 8000, messages: [
        m.d6_hint_network_8s_1(),
        m.d6_hint_network_8s_2(),
      ]},
      { delay: 15000, messages: [
        m.d6_hint_network_15s_1(),
        m.d6_hint_network_15s_2(),
      ]},
    ],
    config: [
      { delay: 3000, messages: [
        m.d6_hint_config_3s_1(),
        m.d6_hint_config_3s_2(),
      ]},
      { delay: 8000, messages: [
        m.d6_hint_config_8s_1(),
        m.d6_hint_config_8s_2(),
      ]},
      { delay: 15000, messages: [
        m.d6_hint_config_15s_1(),
      ]},
    ],
    members: [
      { delay: 3000, messages: [
        m.d6_hint_members_3s_1(),
        m.d6_hint_members_3s_2(),
      ]},
      { delay: 8000, messages: [
        m.d6_hint_members_8s_1(),
        m.d6_hint_members_8s_2(),
      ]},
      { delay: 15000, messages: [
        m.d6_hint_members_15s_1(),
        m.d6_hint_members_15s_2(),
      ]},
    ],
    default: [
      { delay: 3000, messages: [
        m.d6_hint_default_3s_1(),
        m.d6_hint_default_3s_2(),
        m.d6_hint_default_3s_3(),
      ]},
      { delay: 8000, messages: [
        m.d6_hint_default_8s_1(),
        m.d6_hint_default_8s_2(),
        m.d6_hint_default_8s_3(),
      ]},
      { delay: 15000, messages: [
        m.d6_hint_default_15s_1(),
        m.d6_hint_default_15s_2(),
      ]},
      { delay: 25000, messages: [
        m.d6_hint_default_25s_1(),
      ]},
    ],
  };

  let elapsed = $state(0);
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let pickedIndex = $state(0);

  $effect(() => {
    elapsed = 0;
    pickedIndex = Math.floor(Math.random() * 100);
    intervalId = setInterval(() => { elapsed += 1000; }, 1000);
    return () => { if (intervalId) clearInterval(intervalId); };
  });

  const currentHint = $derived.by(() => {
    const sets = hintSets[context] ?? hintSets.default;
    let matched: HintSet | null = null;
    for (const set of sets) {
      if (elapsed >= set.delay) matched = set;
    }
    if (!matched) return '';
    return matched.messages[pickedIndex % matched.messages.length];
  });
</script>

{#if currentHint}
  <p class="text-xs text-on-surface-variant/50 mt-2 animate-fade-hint {className}" role="status">
    {currentHint}
  </p>
{/if}

<style>
  .animate-fade-hint {
    animation: fadeHint 0.5s ease-in-out;
  }
  @keyframes fadeHint {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
