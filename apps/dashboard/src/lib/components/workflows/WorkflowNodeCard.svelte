<script lang="ts">
  import { Handle, Position } from '@xyflow/svelte';
  import { PORT_COLORS, getNodeDef, resolveNodeInputs, resolveNodeOutputs, type PortDef, type WorkflowGraph } from '@kotbo/shared';
  import Papicon from '../Papicon.svelte';
  import WorkflowMessageModal from './WorkflowMessageModal.svelte';

  /**
   * Rendu d'un bloc sur le canvas avec saisie directe et éditeur WYSIWYG.
   */
  const { id, data, selected }: {
    id: string;
    data: {
      nodeType: string;
      config?: Record<string, unknown>;
      graph: WorkflowGraph;
      hasError?: boolean;
      replayOrder?: number | null;
      replayStatus?: 'OK' | 'ERROR' | 'SKIPPED' | null;
      availableRoles?: { id: string; name: string }[];
      availableChannels?: { id: string; name: string }[];
      onUpdateConfig?: (key: string, value: unknown) => void;
    };
    selected?: boolean;
  } = $props();

  let showMessageModal = $state(false);
  let modalConfigKey = $state('text');
  let modalTitle = $state('Éditer le message');

  const def = $derived(getNodeDef(data.nodeType));
  /** Le nœud tel qu'il est configuré, seule forme qui porte les ports variables. */
  const shaped = $derived({ id, type: data.nodeType, position: { x: 0, y: 0 }, config: data.config });
  const outputs = $derived(def ? resolveNodeOutputs(shaped, data.graph) : []);
  // Les emplacements d'un « Texte composé » n'existent que dans sa
  // configuration : sans ce résolveur, la carte ne dessinait aucune poignée
  // pour eux et ils restaient impossibles à alimenter.
  const inputs = $derived(def ? resolveNodeInputs(shaped) : []);

  const execInputs = $derived(inputs.filter((p: PortDef) => p.type === 'Exec'));
  const dataInputs = $derived(inputs.filter((p: PortDef) => p.type !== 'Exec'));
  const execOutputs = $derived(outputs.filter((p: PortDef) => p.type === 'Exec'));
  const dataOutputs = $derived(outputs.filter((p: PortDef) => p.type !== 'Exec'));

  const CATEGORY_ACCENT: Record<string, string> = {
    trigger: '#ef4444',
    flow: '#eab308',
    action: '#10b981',
    data: '#0ea5e9',
    logic: '#a855f7',
  };

  const accent = $derived(CATEGORY_ACCENT[def?.category ?? 'action'] ?? '#64748b');

  /**
   * Un seul anneau à la fois.
   *
   * Empiler `ring-2 ring-red-500` et `ring-2 ring-amber-400` laissait l'ordre
   * de la feuille de style décider, pas celui des classes : un pas en erreur
   * finissait cerclé d'ambre, ce qui cachait justement l'erreur. L'échec passe
   * donc devant le rejeu, qui passe devant la sélection.
   */
  const ring = $derived(
    data.replayStatus === 'ERROR' ? 'ring-2 ring-red-500'
      : data.replayOrder != null ? 'ring-2 ring-amber-400'
        : selected ? 'ring-2 ring-primary/30'
          : '',
  );
  const maxExecRows = $derived(Math.max(execInputs.length, execOutputs.length));
  const maxDataRows = $derived(Math.max(dataInputs.length, dataOutputs.length));

  function getExecInputLabel(port: PortDef): string {
    return port.label || 'Entrée';
  }

  function getExecOutputLabel(port: PortDef): string {
    if (port.label) return port.label;
    if (def?.category === 'trigger') return 'Déclencher';
    return 'Suivant';
  }

  function getDataPortLabel(port: PortDef): string {
    return port.label || port.id;
  }

  function isInputConnected(portId: string): boolean {
    if (!data.graph?.edges) return false;
    return data.graph.edges.some((e) => e.target === id && e.targetHandle === portId);
  }

  function openWysiwyg(key: string, titleStr: string) {
    modalConfigKey = key;
    modalTitle = titleStr;
    showMessageModal = true;
  }

  // Est-ce un nœud qui manipule du texte/message ?
</script>

<!-- `transition-colors` et pas `transition-all` : la sélection change la
     bordure et l'anneau, or Tailwind construit l'anneau avec `box-shadow`.
     Animer cette propriété interdit toute composition GPU et repeint la zone
     floutée de chaque carte à chaque image. Pendant un tracé de sélection, des
     dizaines de cartes basculent en continu : c'est là que le canevas
     s'effondre. L'ombre passe de `2xl` (flou de 50 px) à `lg` pour la même
     raison, la surface repeinte étant proportionnelle au rayon. -->
<div
  class="rounded-xl border-2 bg-surface-container-high shadow-lg min-w-64 overflow-visible transition-colors relative
    {data.hasError && !selected ? 'border-red-500' : selected ? 'border-primary' : 'border-outline-variant/30'}
    {ring}"
  style="--accent: {accent}"
>
  <!-- En-tête -->
  <div class="px-3.5 py-2.5 rounded-t-[10px] flex items-center gap-2 border-b border-outline-variant/15" style="background: {accent}2b">
    <span class="w-2.5 h-2.5 rounded-full shrink-0 shadow-sm" style="background: {accent}"></span>
    <span class="text-xs font-bold text-on-surface tracking-wide truncate">{def?.label ?? data.nodeType}</span>
    {#if data.replayOrder != null}
      <span
        class="ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded shadow-sm {data.replayStatus === 'ERROR'
          ? 'bg-red-500 text-white'
          : data.replayStatus === 'SKIPPED'
            ? 'bg-surface-container-highest text-on-surface-variant'
            : 'bg-amber-400 text-black'}"
      >
        {data.replayOrder + 1}
      </span>
    {/if}
  </div>

  <!-- Corps du nœud -->
  <div class="p-3 space-y-2 text-xs text-on-surface-variant">
    <!-- Ports d'exécution (Exec) -->
    {#if maxExecRows > 0}
      <div class="space-y-1.5 pb-2 border-b border-outline-variant/15">
        {#each Array(maxExecRows) as _, i}
          {@const inPort = execInputs[i]}
          {@const outPort = execOutputs[i]}
          <div class="flex items-center justify-between h-6 gap-3">
            <!-- Port d'entrée d'exécution (Gauche) -->
            <div class="relative flex items-center min-w-0 h-6">
              {#if inPort}
                <Handle
                  type="target"
                  position={Position.Left}
                  id={inPort.id}
                  title="Entrée de flux (Exec)"
                  style="left: -18px; top: 50%; transform: translateY(-50%); background: {PORT_COLORS.Exec}; width: 10px; height: 10px; border-radius: 2px; border: 1.5px solid rgba(15, 23, 42, 0.8);"
                />
                <span class="truncate font-semibold text-on-surface text-xs flex items-center gap-1">
                  <span class="text-[9px] opacity-50">►</span>
                  {getExecInputLabel(inPort)}
                </span>
              {/if}
            </div>

            <!-- Port de sortie d'exécution (Droite) -->
            <div class="relative flex items-center justify-end min-w-0 ml-auto h-6">
              {#if outPort}
                <span class="truncate font-semibold text-on-surface text-xs text-right flex items-center gap-1">
                  {getExecOutputLabel(outPort)}
                  <span class="text-[9px] opacity-50">►</span>
                </span>
                <Handle
                  type="source"
                  position={Position.Right}
                  id={outPort.id}
                  title="{getExecOutputLabel(outPort)} (Flux Exec)"
                  style="right: -18px; top: 50%; transform: translateY(-50%); background: {PORT_COLORS.Exec}; width: 10px; height: 10px; border-radius: 2px; border: 1.5px solid rgba(15, 23, 42, 0.8);"
                />
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Configuration de base issue du catalogue -->
    {#if def?.config && def.config.length > 0}
      <div class="px-2 py-2 my-1 rounded-lg bg-surface-container-highest/40 border border-outline-variant/15 space-y-1.5 nodrag">
        {#each def.config as field}
          <div class="space-y-1">
            <label for="node-cfg-{id}-{field.key}" class="text-[9px] font-bold text-on-surface-variant/80 uppercase tracking-wider block">
              {field.label}
            </label>

            {#if field.type === 'role'}
              <select
                id="node-cfg-{id}-{field.key}"
                value={String(data.config?.[field.key] ?? '')}
                onchange={(e) => data.onUpdateConfig?.(field.key, e.currentTarget.value)}
                class="nodrag w-full px-2 py-1 rounded bg-surface-container border border-outline-variant/30 text-xs text-on-surface focus:ring-1 focus:ring-primary/50 outline-none cursor-pointer"
              >
                <option value="">- Choisir un rôle -</option>
                {#each (data.availableRoles ?? []) as role}
                  <option value={role.id}>@{role.name}</option>
                {/each}
              </select>

            {:else if field.type === 'channel'}
              <select
                id="node-cfg-{id}-{field.key}"
                value={String(data.config?.[field.key] ?? '')}
                onchange={(e) => data.onUpdateConfig?.(field.key, e.currentTarget.value)}
                class="nodrag w-full px-2 py-1 rounded bg-surface-container border border-outline-variant/30 text-xs text-on-surface focus:ring-1 focus:ring-primary/50 outline-none cursor-pointer"
              >
                <option value="">- Choisir un salon -</option>
                {#each (data.availableChannels ?? []) as channel}
                  <option value={channel.id}>#{channel.name}</option>
                {/each}
              </select>

            {:else if field.type === 'select'}
              <select
                id="node-cfg-{id}-{field.key}"
                value={String(data.config?.[field.key] ?? field.defaultValue ?? '')}
                onchange={(e) => data.onUpdateConfig?.(field.key, e.currentTarget.value)}
                class="nodrag w-full px-2 py-1 rounded bg-surface-container border border-outline-variant/30 text-xs text-on-surface focus:ring-1 focus:ring-primary/50 outline-none cursor-pointer"
              >
                {#each field.options ?? [] as option}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </select>

            {:else if field.type === 'number'}
              <input
                id="node-cfg-{id}-{field.key}"
                type="number"
                min={field.min}
                max={field.max}
                value={Number(data.config?.[field.key] ?? field.defaultValue ?? 0)}
                oninput={(e) => data.onUpdateConfig?.(field.key, Number(e.currentTarget.value))}
                class="nodrag w-full px-2 py-1 rounded bg-surface-container border border-outline-variant/30 text-xs text-on-surface focus:ring-1 focus:ring-primary/50 outline-none"
              />

            {:else if field.type === 'boolean'}
              <label class="flex items-center gap-2 cursor-pointer nodrag py-0.5">
                <input
                  id="node-cfg-{id}-{field.key}"
                  type="checkbox"
                  checked={Boolean(data.config?.[field.key] ?? field.defaultValue ?? false)}
                  onchange={(e) => data.onUpdateConfig?.(field.key, e.currentTarget.checked)}
                  class="w-3.5 h-3.5 rounded accent-primary cursor-pointer"
                />
                <span class="text-xs text-on-surface font-medium">{field.label}</span>
              </label>

            {:else if field.type === 'textarea'}
              <textarea
                id="node-cfg-{id}-{field.key}"
                rows="2"
                value={String(data.config?.[field.key] ?? '')}
                oninput={(e) => data.onUpdateConfig?.(field.key, e.currentTarget.value)}
                placeholder={field.placeholder || 'Saisir du texte...'}
                class="nodrag w-full px-2 py-1 rounded bg-surface-container border border-outline-variant/30 text-xs text-on-surface focus:ring-1 focus:ring-primary/50 outline-none resize-none"
              ></textarea>

            {:else if field.type === 'text'}
              <input
                id="node-cfg-{id}-{field.key}"
                type="text"
                value={String(data.config?.[field.key] ?? '')}
                oninput={(e) => data.onUpdateConfig?.(field.key, e.currentTarget.value)}
                placeholder={field.placeholder || 'Saisir du texte...'}
                class="nodrag w-full px-2 py-1 rounded bg-surface-container border border-outline-variant/30 text-xs text-on-surface focus:ring-1 focus:ring-primary/50 outline-none"
              />
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    <!-- Saisie directe pour les ports d'entrée de données non reliés par un fil -->
    {#if dataInputs.length > 0}
      <div class="space-y-2 py-1">
        {#each dataInputs as inputPort}
          {@const connected = isInputConnected(inputPort.id)}
          {#if !connected}
            <div class="px-2 py-1.5 rounded-lg bg-surface-container-highest/30 border border-outline-variant/10 space-y-1 nodrag">
              <label for="direct-input-{id}-{inputPort.id}" class="text-[9px] font-bold text-on-surface-variant/70 uppercase tracking-wider block">
                {getDataPortLabel(inputPort)} (Direct)
              </label>

              {#if inputPort.type === 'Channel'}
                <select
                  id="direct-input-{id}-{inputPort.id}"
                  value={String(data.config?.channelId ?? data.config?.[inputPort.id] ?? '')}
                  onchange={(e) => {
                    data.onUpdateConfig?.(inputPort.id, e.currentTarget.value);
                    data.onUpdateConfig?.('channelId', e.currentTarget.value);
                  }}
                  class="nodrag w-full px-2 py-1 rounded bg-surface-container border border-outline-variant/30 text-xs text-on-surface focus:ring-1 focus:ring-primary/50 outline-none cursor-pointer"
                >
                  <option value="">- Sélectionner un salon -</option>
                  {#each (data.availableChannels ?? []) as channel}
                    <option value={channel.id}>#{channel.name}</option>
                  {/each}
                </select>

              {:else if inputPort.type === 'Role'}
                <select
                  id="direct-input-{id}-{inputPort.id}"
                  value={String(data.config?.roleId ?? data.config?.[inputPort.id] ?? '')}
                  onchange={(e) => {
                    data.onUpdateConfig?.(inputPort.id, e.currentTarget.value);
                    data.onUpdateConfig?.('roleId', e.currentTarget.value);
                  }}
                  class="nodrag w-full px-2 py-1 rounded bg-surface-container border border-outline-variant/30 text-xs text-on-surface focus:ring-1 focus:ring-primary/50 outline-none cursor-pointer"
                >
                  <option value="">- Sélectionner un rôle -</option>
                  {#each (data.availableRoles ?? []) as role}
                    <option value={role.id}>@{role.name}</option>
                  {/each}
                </select>

              {:else if inputPort.type === 'String' && (inputPort.id === 'text' || inputPort.id === 'description')}
                <div class="space-y-1">
                  <input
                    id="direct-input-{id}-{inputPort.id}"
                    type="text"
                    value={String(data.config?.[inputPort.id] ?? '')}
                    oninput={(e) => data.onUpdateConfig?.(inputPort.id, e.currentTarget.value)}
                    placeholder="Ecrire le texte ici..."
                    class="nodrag w-full px-2 py-1 rounded bg-surface-container border border-outline-variant/30 text-xs text-on-surface focus:ring-1 focus:ring-primary/50 outline-none"
                  />
                  <button
                    type="button"
                    onclick={() => openWysiwyg(inputPort.id, `Éditer "${getDataPortLabel(inputPort)}"`)}
                    class="nodrag w-full px-2 py-1 rounded bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/30 text-[10px] font-semibold text-indigo-700 dark:text-indigo-300 transition-all flex items-center justify-center gap-1"
                  >
                    <Papicon icon="TextBubble" size={11} />
                    <span>✏️ Éditeur WYSIWYG / Aperçu</span>
                  </button>
                </div>

              {:else if inputPort.type === 'String'}
                <input
                  id="direct-input-{id}-{inputPort.id}"
                  type="text"
                  value={String(data.config?.[inputPort.id] ?? '')}
                  oninput={(e) => data.onUpdateConfig?.(inputPort.id, e.currentTarget.value)}
                  placeholder="Valeur..."
                  class="nodrag w-full px-2 py-1 rounded bg-surface-container border border-outline-variant/30 text-xs text-on-surface focus:ring-1 focus:ring-primary/50 outline-none"
                />

              {:else if inputPort.type === 'Number'}
                <input
                  id="direct-input-{id}-{inputPort.id}"
                  type="number"
                  value={Number(data.config?.[inputPort.id] ?? 0)}
                  oninput={(e) => data.onUpdateConfig?.(inputPort.id, Number(e.currentTarget.value))}
                  class="nodrag w-full px-2 py-1 rounded bg-surface-container border border-outline-variant/30 text-xs text-on-surface focus:ring-1 focus:ring-primary/50 outline-none"
                />
              {/if}
            </div>
          {/if}
        {/each}
      </div>
    {/if}

    <!-- Bouton WYSIWYG pour ConstText si présent -->
    {#if data.nodeType === 'ConstText'}
      <button
        type="button"
        onclick={() => openWysiwyg('value', 'Éditer le texte fixe')}
        class="nodrag w-full px-2 py-1 rounded bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/30 text-[10px] font-semibold text-indigo-700 dark:text-indigo-300 transition-all flex items-center justify-center gap-1"
      >
        <Papicon icon="TextBubble" size={11} />
        <span>✏️ Éditeur WYSIWYG / Aperçu</span>
      </button>
    {/if}

    <!-- Ports de données (Handles visuels : Inputs à gauche, Outputs à droite) -->
    {#if maxDataRows > 0}
      <div class="space-y-1.5 pt-1">
        {#each Array(maxDataRows) as _, i}
          {@const inputPort = dataInputs[i]}
          {@const outputPort = dataOutputs[i]}
          <div class="flex items-center justify-between h-6 gap-3">
            <!-- Port d'entrée (Gauche) -->
            <div class="relative flex items-center min-w-0 h-6">
              {#if inputPort}
                <Handle
                  type="target"
                  position={Position.Left}
                  id={inputPort.id}
                  title="{getDataPortLabel(inputPort)} (Type: {inputPort.type})"
                  style="left: -18px; top: 50%; transform: translateY(-50%); background: {PORT_COLORS[inputPort.type] ?? '#94a3b8'}; width: 10px; height: 10px; border-radius: 50%; border: 1.5px solid rgba(15, 23, 42, 0.8);"
                />
                <span class="truncate font-medium text-on-surface-variant text-xs" title="Type: {inputPort.type}">{getDataPortLabel(inputPort)}</span>
              {/if}
            </div>

            <!-- Port de sortie (Droite) -->
            <div class="relative flex items-center justify-end min-w-0 ml-auto h-6">
              {#if outputPort}
                <span class="truncate text-right font-medium text-on-surface-variant text-xs" title="Type: {outputPort.type}">{getDataPortLabel(outputPort)}</span>
                <Handle
                  type="source"
                  position={Position.Right}
                  id={outputPort.id}
                  title="{getDataPortLabel(outputPort)} (Type: {outputPort.type})"
                  style="right: -18px; top: 50%; transform: translateY(-50%); background: {PORT_COLORS[outputPort.type] ?? '#94a3b8'}; width: 10px; height: 10px; border-radius: 50%; border: 1.5px solid rgba(15, 23, 42, 0.8);"
                />
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<!-- Modal Éditeur WYSIWYG -->
<WorkflowMessageModal
  open={showMessageModal}
  title={modalTitle}
  initialText={String(data.config?.[modalConfigKey] ?? '')}
  onSave={(newText) => {
    data.onUpdateConfig?.(modalConfigKey, newText);
  }}
  onClose={() => (showMessageModal = false)}
/>
