<script lang="ts">
  /**
   * Liste d'emojis modifiable : pastilles retirables, saisie libre et sélecteur.
   *
   * Un emoji custom est stocké sous son seul id - le nom peut changer sur le
   * serveur, l'id non. La normalisation appliquée ici est celle du bot, pour
   * que la pastille affichée corresponde à ce qui sera enregistré.
   */
  import { m } from '../i18n';
  import EmojiPicker from './EmojiPicker.svelte';
  import Papicon from './Papicon.svelte';

  let {
    values = $bindable<string[]>([]),
    disabled = false,
    accentClass = 'bg-primary/10 border-primary/25 hover:bg-primary/20',
    placeholder = '',
    id = '',
  }: {
    values: string[];
    disabled?: boolean;
    accentClass?: string;
    placeholder?: string;
    id?: string;
  } = $props();

  let draft = $state('');
  /** Le sélecteur écrit ici ; l'ajout se fait dans l'effet ci-dessous. */
  let picked = $state('');

  const CUSTOM_EMOJI_RE = /^<?a?:([^:\s]+):(\d{15,25})>?$/;
  const EMOJI_ID_RE = /^\d{15,25}$/;

  function normalize(raw: string): string {
    const trimmed = raw.trim();
    const custom = trimmed.match(CUSTOM_EMOJI_RE);
    return custom ? custom[2] : trimmed;
  }

  function add(raw: string) {
    const emoji = normalize(raw);
    if (!emoji || values.includes(emoji)) return;
    values = [...values, emoji];
  }

  function remove(emoji: string) {
    values = values.filter((e) => e !== emoji);
  }

  function commitDraft() {
    add(draft);
    draft = '';
  }

  // Le sélecteur n'expose qu'une valeur liée : on la consomme dès qu'elle
  // change, puis on la remet à vide pour que le même emoji puisse être
  // rechoisi plus tard.
  $effect(() => {
    if (!picked) return;
    const chosen = picked;
    picked = '';
    add(chosen);
  });

  /** Un id nu est un emoji custom : on le rend via le CDN Discord. */
  function imageUrl(emoji: string): string | null {
    return EMOJI_ID_RE.test(emoji)
      ? `https://cdn.discordapp.com/emojis/${emoji}.webp?size=32&quality=lossless`
      : null;
  }
</script>

<div class="flex flex-wrap gap-2 min-h-11 p-2 bg-surface-container border border-outline-variant rounded-lg">
  {#each values as emoji (emoji)}
    {@const url = imageUrl(emoji)}
    <button
      type="button"
      onclick={() => remove(emoji)}
      {disabled}
      aria-label={m.starboard_emoji_remove({ emoji })}
      class="group flex items-center gap-1.5 pl-2 pr-1.5 py-1 rounded-md text-sm border transition-all disabled:opacity-50 {accentClass}"
    >
      {#if url}
        <img src={url} alt="" class="w-5 h-5" />
      {:else}
        <span>{emoji}</span>
      {/if}
      <Papicon icon="x" size={12} class="opacity-40 group-hover:opacity-90" />
    </button>
  {:else}
    <span class="text-xs text-on-surface-variant/50 self-center px-1">{m.starboard_emoji_empty()}</span>
  {/each}
</div>

<div class="flex items-center gap-2 mt-2">
  <input
    {id}
    type="text"
    bind:value={draft}
    onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitDraft(); } }}
    {placeholder}
    {disabled}
    class="flex-1 min-w-0 bg-surface-container border border-outline-variant rounded-lg px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary/60 disabled:opacity-50"
  />
  <EmojiPicker bind:value={picked} {disabled} format="id" />
  <button type="button" class="btn btn-tonal btn-sm shrink-0" {disabled} onclick={commitDraft}>
    {m.starboard_emoji_add()}
  </button>
</div>
