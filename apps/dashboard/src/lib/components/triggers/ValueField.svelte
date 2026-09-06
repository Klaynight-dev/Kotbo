<script lang="ts">
  import { m } from '../../i18n';
  import Papicon from '../Papicon.svelte';
  import { tokensOfType, type ContextToken, type FieldKind, type ValueRef } from '@kotbo/shared';

  /**
   * Un trou dans une phrase.
   *
   * Toute la charge d'intuitivité de l'éditeur se joue ici : le contrôle
   * affiché découle de la nature du champ, jamais d'un type de port. Sauf pour
   * le texte, aucune saisie n'est libre - on choisit dans une liste, ce qui
   * rend une étape invalide impossible à écrire à la main.
   */
  const {
    kind,
    value,
    triggerType,
    placeholder = '',
    optional = false,
    roles = [],
    channels = [],
    onChange,
  }: {
    kind: FieldKind;
    value?: ValueRef;
    triggerType: string;
    placeholder?: string;
    optional?: boolean;
    roles?: { id: string; name: string }[];
    channels?: { id: string; name: string }[];
    onChange: (value: ValueRef) => void;
  } = $props();

  let input = $state<HTMLInputElement | null>(null);

  const contextChoices = $derived.by((): ContextToken[] => {
    if (kind === 'member') return tokensOfType(triggerType, 'Member');
    if (kind === 'role') return tokensOfType(triggerType, 'Role');
    if (kind === 'channel') return tokensOfType(triggerType, 'Channel');
    if (kind === 'message') return tokensOfType(triggerType, 'Message');
    return [];
  });

  /** Jetons proposés sous un champ texte, entités brutes exclues. */
  const textTokens = $derived(
    ['String', 'Number', 'Member', 'Channel', 'Role'].flatMap((type) =>
      tokensOfType(triggerType, type as never),
    ),
  );

  /** Valeur du `select`, préfixée pour distinguer contexte et choix fixe. */
  const selected = $derived.by(() => {
    if (!value) return '';
    if (value.from === 'context') return `ctx:${value.path}`;
    if (value.from === 'role') return `lit:${value.roleId}`;
    if (value.from === 'channel') return `lit:${value.channelId}`;
    return '';
  });

  function pick(raw: string): void {
    if (raw.startsWith('ctx:')) {
      onChange({ from: 'context', path: raw.slice(4) });
      return;
    }
    const id = raw.slice(4);
    onChange(kind === 'role' ? { from: 'role', roleId: id } : { from: 'channel', channelId: id });
  }

  /** Insère un jeton à l'endroit du curseur plutôt qu'en fin de champ. */
  function insertToken(path: string): void {
    const template = value?.from === 'text' ? value.template : '';
    const at = input?.selectionStart ?? template.length;
    const next = `${template.slice(0, at)}{${path}}${template.slice(at)}`;
    onChange({ from: 'text', template: next });

    requestAnimationFrame(() => {
      input?.focus();
      const caret = at + path.length + 2;
      input?.setSelectionRange(caret, caret);
    });
  }

  const isEmpty = $derived.by(() => {
    if (!value) return true;
    if (value.from === 'text') return value.template.trim() === '';
    if (value.from === 'role') return !value.roleId;
    if (value.from === 'channel') return !value.channelId;
    if (value.from === 'context') return !value.path;
    return false;
  });

  const chipClass = $derived(
    `inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
      isEmpty && !optional
        ? 'bg-amber-500/10 border-amber-500/40 text-amber-800 dark:text-amber-200'
        : 'bg-surface-container-highest border-outline-variant/25 text-on-surface hover:border-primary/40'
    }`,
  );
</script>

{#if kind === 'richtext'}
  <span class="inline-flex flex-col gap-1 align-middle">
    <input
      bind:this={input}
      type="text"
      value={value?.from === 'text' ? value.template : ''}
      {placeholder}
      oninput={(event) => onChange({ from: 'text', template: event.currentTarget.value })}
      class="{chipClass} min-w-52 w-full max-w-md focus:outline-none focus:border-primary/60"
    />
    {#if textTokens.length > 0}
      <span class="flex flex-wrap items-center gap-1">
        <span class="text-[10px] text-on-surface-variant/70 uppercase tracking-wider">{m.wf_insert()}</span>
        {#each textTokens.slice(0, 8) as token (token.path)}
          <button
            type="button"
            onclick={() => insertToken(token.path)}
            class="px-1.5 py-0.5 rounded-md text-[10px] bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 transition-colors"
          >{token.label}</button>
        {/each}
      </span>
    {/if}
  </span>
{:else if kind === 'number'}
  <input
    type="number"
    value={value?.from === 'number' ? value.value : ''}
    placeholder={placeholder || '0'}
    oninput={(event) => onChange({ from: 'number', value: Number(event.currentTarget.value) })}
    class="{chipClass} w-24 focus:outline-none focus:border-primary/60"
  />
{:else if kind === 'color'}
  <input
    type="color"
    value={value?.from === 'text' ? value.template : '#5865F2'}
    oninput={(event) => onChange({ from: 'text', template: event.currentTarget.value })}
    class="w-9 h-7 rounded-lg bg-transparent border border-outline-variant/25 cursor-pointer"
  />
{:else}
  <span class="relative inline-flex">
    <select
      value={selected}
      onchange={(event) => pick(event.currentTarget.value)}
      class="{chipClass} appearance-none pr-7 cursor-pointer focus:outline-none"
    >
      <option value="" disabled>
        {kind === 'role' ? m.wf_choose_role() : kind === 'channel' ? m.wf_choose_channel() : kind === 'message' ? m.wf_choose_message() : m.wf_choose_member()}
      </option>

      {#if contextChoices.length > 0}
        <optgroup label={m.wf_from_trigger()}>
          {#each contextChoices as token (token.path)}
            <option value="ctx:{token.path}">{token.label}</option>
          {/each}
        </optgroup>
      {/if}

      {#if kind === 'role' && roles.length > 0}
        <optgroup label={m.wf_server_roles()}>
          {#each roles as role (role.id)}
            <option value="lit:{role.id}">@{role.name}</option>
          {/each}
        </optgroup>
      {/if}

      {#if kind === 'channel' && channels.length > 0}
        <optgroup label={m.wf_server_channels()}>
          {#each channels as channel (channel.id)}
            <option value="lit:{channel.id}">#{channel.name}</option>
          {/each}
        </optgroup>
      {/if}
    </select>
    <Papicon
      icon="ChevronDown"
      size={12}
      class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-on-surface-variant/70"
    />
  </span>
{/if}
