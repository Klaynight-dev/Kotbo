<script lang="ts">
  import { m } from '../../i18n';
  import Papicon from '../Papicon.svelte';
  import { NODE_CATALOG, PORT_COLORS, canConnect, type NodeDef, type PortDef, type PortDataType } from '@kotbo/shared';

  /**
   * Choix du bloc à créer au bout d'un fil relâché dans le vide.
   *
   * Ne proposer que ce qui accepte le type tiré évite l'aller-retour habituel :
   * poser un bloc au jugé, découvrir qu'il ne se branche pas, recommencer. Le
   * port retenu sur le bloc créé est le premier compatible, celui que
   * l'utilisateur aurait choisi dans la quasi-totalité des cas.
   */
  const {
    portType,
    direction,
    onPick,
    onClose,
  }: {
    portType: PortDataType;
    /** `source` : on a tiré depuis une sortie, il faut donc une entrée. */
    direction: 'source' | 'target';
    onPick: (nodeType: string, portId: string) => void;
    onClose: () => void;
  } = $props();

  let search = $state('');

  /**
   * Port du bloc capable d'accueillir - ou d'alimenter - le fil tiré.
   *
   * Le type exact passe devant : un bloc qui possède à la fois une entrée du
   * bon type et une entrée texte doit se brancher sur la première, pas sur
   * celle qui ne marche que par conversion.
   */
  function matchingPort(def: NodeDef): PortDef | null {
    const ports = direction === 'source' ? def.inputs : def.outputs;
    const fits = (port: PortDef) => (direction === 'source'
      ? canConnect(portType, port.type)
      : canConnect(port.type, portType));

    return ports.find((port) => port.type === portType && fits(port)) ?? ports.find(fits) ?? null;
  }

  const candidates = $derived(
    NODE_CATALOG
      // Un déclencheur ouvre le graphe : rien ne se branche en amont de lui,
      // et il n'a donc rien à proposer au bout d'une sortie tirée.
      .filter((def) => direction === 'target' || def.category !== 'trigger')
      .map((def) => ({ def, port: matchingPort(def) }))
      .filter((entry): entry is { def: NodeDef; port: PortDef } => entry.port !== null)
      .filter((entry) => (
        !search.trim()
        || entry.def.label.toLowerCase().includes(search.toLowerCase())
        || entry.def.description.toLowerCase().includes(search.toLowerCase())
      )),
  );

  /**
   * Tout type métier se convertit en texte : sans séparation, tirer un membre
   * proposerait la moitié du catalogue, « Concaténer » au milieu des actions
   * de modération. Le branchement exact d'abord, la conversion ensuite.
   */
  const exact = $derived(candidates.filter((entry) => entry.port.type === portType));
  const coerced = $derived(candidates.filter((entry) => entry.port.type !== portType));
</script>

<div class="fixed inset-0 z-50 flex items-start justify-center p-4 pt-24 bg-black/50 backdrop-blur-sm" role="presentation" onclick={onClose}>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="w-full max-w-lg max-h-[60vh] overflow-y-auto rounded-3xl bg-surface-container border border-outline-variant/20 shadow-2xl"
    onclick={(event) => event.stopPropagation()}
  >
    <div class="sticky top-0 p-4 bg-surface-container border-b border-outline-variant/15 space-y-3">
      <div class="flex items-center justify-between gap-3">
        <h3 class="text-sm font-bold text-on-surface flex items-center gap-2">
          <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background: {PORT_COLORS[portType]}"></span>
          {m.wf_connect_picker_title({ type: portType })}
        </h3>
        <button
          onclick={onClose}
          class="p-1.5 rounded-lg text-on-surface-variant/70 hover:text-on-surface hover:bg-surface-container-highest transition-colors"
          aria-label={m.wf_close()}
        ><Papicon icon="Cross" size={15} /></button>
      </div>
      <input
        type="text"
        bind:value={search}
        placeholder={m.wf_search_block()}
        class="w-full px-3 py-2 rounded-xl bg-surface-container-highest border border-outline-variant/20 text-xs text-on-surface focus:border-primary/50 focus:outline-none"
      />
    </div>

    <div class="p-3 space-y-1.5">
      {#if candidates.length === 0}
        <p class="text-xs text-on-surface-variant/70 text-center py-6">{m.wf_no_block_found()}</p>
      {:else}
        {#each [{ items: exact, label: '' }, { items: coerced, label: m.wf_connect_coerced() }] as group (group.label)}
          {#if group.items.length > 0}
            {#if group.label}
              <p class="pt-3 pb-1 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70">{group.label}</p>
            {/if}
            {#each group.items as entry (entry.def.type)}
              <button
                type="button"
                onclick={() => onPick(entry.def.type, entry.port.id)}
                class="w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-left bg-surface-container-highest/50 border border-outline-variant/10 hover:border-primary/40 hover:bg-surface-container-highest transition-all"
              >
                <span class="min-w-0 space-y-0.5">
                  <span class="block text-xs font-semibold text-on-surface">{entry.def.label}</span>
                  <span class="block text-[11px] text-on-surface-variant/70 leading-snug">{entry.def.description}</span>
                </span>
                <span class="shrink-0 flex items-center gap-1.5 text-[10px] text-on-surface-variant/70">
                  <span class="w-2 h-2 rounded-full" style="background: {PORT_COLORS[entry.port.type]}"></span>
                  {entry.port.label || entry.port.type}
                </span>
              </button>
            {/each}
          {/if}
        {/each}
      {/if}
    </div>
  </div>
</div>
