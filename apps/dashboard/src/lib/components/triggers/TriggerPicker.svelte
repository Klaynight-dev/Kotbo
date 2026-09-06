<script lang="ts">
  import Papicon from '../Papicon.svelte';
  import { TRIGGER_GROUP_LABELS, TRIGGER_LIBRARY, type TriggerGroup } from '@kotbo/shared';

  /**
   * Choix du déclencheur - la toute première question posée.
   *
   * Chaque carte porte la phrase complète et un exemple concret : le but est
   * qu'on reconnaisse son besoin dans un exemple plutôt que d'avoir à traduire
   * une intention en vocabulaire technique.
   */
  const {
    selected = '',
    onPick,
  }: {
    selected?: string;
    onPick: (type: string) => void;
  } = $props();

  const groups = [...new Set(TRIGGER_LIBRARY.map((trigger) => trigger.group))] as TriggerGroup[];
</script>

<div class="space-y-5">
  {#each groups as group (group)}
    <section class="space-y-2">
      <h4 class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70">
        {TRIGGER_GROUP_LABELS[group]}
      </h4>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
        {#each TRIGGER_LIBRARY.filter((trigger) => trigger.group === group) as trigger (trigger.type)}
          <button
            type="button"
            onclick={() => onPick(trigger.type)}
            class="flex items-start gap-3 p-3.5 rounded-2xl text-left border transition-all {selected === trigger.type
              ? 'bg-primary/10 border-primary/50'
              : 'bg-surface-container-high/50 border-outline-variant/15 hover:border-primary/30 hover:bg-surface-container-high'}"
          >
            <span class="p-2 rounded-xl bg-primary/10 text-primary shrink-0">
              <Papicon icon={trigger.icon} size={15} />
            </span>
            <span class="min-w-0 space-y-0.5">
              <span class="block text-xs font-semibold text-on-surface">{trigger.sentence}</span>
              <span class="block text-[11px] text-on-surface-variant/70 leading-snug">{trigger.example}</span>
            </span>
          </button>
        {/each}
      </div>
    </section>
  {/each}
</div>
