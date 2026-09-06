<script lang="ts">
  /**
   * Sélecteur d'emoji à trois entrées : les emojis du serveur, le catalogue
   * Unicode, et le dépôt d'une image qui devient un emoji du serveur.
   *
   * Les deux dernières existaient déjà ; la première manquait, et c'est elle
   * qu'on cherche en premier quand on configure une monnaie ou une boutique -
   * un serveur qui a sa propre pièce n'avait aucun moyen de s'en servir. Le
   * dépôt est là pour la même raison : sans lui, il fallait quitter le
   * dashboard, créer l'emoji dans Discord, puis revenir.
   */
  import { m } from '../i18n';
  import Papicon from './Papicon.svelte';
  import { toast } from '../stores/toast.svelte';
  import {
    fetchGuildEmojis,
    uploadGuildEmoji,
    sanitizeEmojiName,
    GUILD_EMOJI_ACCEPTED,
    GUILD_EMOJI_MAX_BYTES,
    type GuildEmoji,
    type GuildEmojiSet,
  } from '../api';

  let {
    value = $bindable(''),
    disabled = false,
    /**
     * `mention` rend `<:nom:id>`, la seule forme que Discord affiche dans un
     * message. `id` rend l'identifiant nu, attendu là où l'emoji sert de clé
     * de réaction (starboard, rôles-réaction).
     */
    format = 'mention',
  }: {
    value: string;
    disabled?: boolean;
    format?: 'mention' | 'id';
  } = $props();

  let isOpen = $state(false);
  let search = $state('');
  let activeSource = $state<'server' | 'unicode' | 'upload'>('server');
  let activeTab = $state('smileys');
  let pickerEl = $state<HTMLDivElement | null>(null);

  // Emojis du serveur : chargés à la première ouverture, puis gardés.
  let emojiSet = $state<GuildEmojiSet | null>(null);
  let loadingServer = $state(false);
  let serverError = $state('');

  // Dépôt d'une image.
  let uploadFile = $state<File | null>(null);
  let uploadName = $state('');
  let uploadPreview = $state('');
  let uploading = $state(false);
  let dragOver = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);

  const categories = [
    { id: 'smileys', icon: '😀', name: m.d1_emoji_cat_smileys() },
    { id: 'animals', icon: '🐱', name: m.d1_emoji_cat_animals() },
    { id: 'food', icon: '🍏', name: m.d1_emoji_cat_food() },
    { id: 'activities', icon: '⚽', name: m.d1_emoji_cat_activities() },
    { id: 'travel', icon: '🚗', name: m.d1_emoji_cat_travel() },
    { id: 'objects', icon: '💡', name: m.d1_emoji_cat_objects() },
    { id: 'symbols', icon: '❤️', name: m.d1_emoji_cat_symbols() },
    { id: 'flags', icon: '🏁', name: m.d1_emoji_cat_flags() }
  ];

  const emojiMap: Record<string, string[]> = {
    smileys: [
      '😀','😃','😄','😁','😆','😅','😂','🤣','🥲','😊','😇','🙂','🙃','😉','😌','😍','🥰','😘','😗','😙','😚','😋','😛','😝','😜','🤪','🤨','🧐','🤓','😎','🥸','🤩','🥳','😏','😒','😞','😔','😟','😕','🙁','☹️','😣','😖','😫','😩','🥺','😢','😭','😤','😠','😡','🤬','🤯','😳','🥵','🥶','😱','😨','😰','😥','😓','🤗','🤔','🫣','🤭','🤫','🤥','😶','😐','😑','😬','🙄','😯','😦','😧','😮','😲','🥱','😴','🤤','😪','😵','🤐','🥴','🤢','🤮','🤧','😷','🤒','🤕','🤑','🤠','😈','👿','👹','👺','🤡','💩','👻','💀','☠️','👽','👾','🤖'
    ],
    animals: [
      '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐽','🐸','🐵','🙈','🙉','🙊','🐒','🐔','🐧','🐦','🐤','🐣','🐥','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐜','🕷','🕸','🦂','🐢','🐍','🦎','🐙','🦑','🦞','🦀','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🐊','🐆','🐅','🐃','🐂','🐄','🐪','🐫','🦙','🐘','🦣','🦏','🦛','🐐','🐏','🐑','🐎','🐖','🦌','🐕','🐩','🐈','🐈‍⬛','🐓','🦃','🦚','🦩','🦢','🕊','🐇','🐿','🦫','🦡','🦥','🦦','🦨','🦘','🌲','🌳','🌴','🌵','🌱','🌿','🍀','🍁','🍂','🍃','🌸','🌹','🌺','🌻','🌼','🌷'
    ],
    food: [
      '🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌶','🫑','🧅','🧄','🥔','🥕','🌽','🍄','🌰','🥜','🍞','🥐','🥖','🥨','🥯','🥞','🧇','🧀','🍖','🍗','🥩','🥓','🍔','🍟','🍕','🌭','🥪','🌮','🌯','🍳','🥘','🍲','🥣','🥗','🍿','🧈','🧂','🥫','🍱','🍘','🍙','🍚','🍛','🍜','🍝','🍠','🍢','🍣','🍤','🍥','🥮','🍡','🥟','🍪','🎂','🍰','🧁','🥧','🍫','🍬','🍭','🍮','🍯','🍼','🥛','☕','🫖','🍵','🍶','🍷','🍸','🍹','🍺','🍻','🥂','🥃','🥤','🧋','🧃','🧉','🧊'
    ],
    activities: [
      '⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🪀','🏓','🏸','🏒','⛳','🏹','🎣','🥊','🥋','⛸','🛷','🥌','🎯','🪂','🪁','🎮','🕹','🎰','🎲','🧩','♟','🎭','🎨','🎬','🎤','🎧','🎼','🎹','🥁','🎷','🎺','🎸','🪕','🎻','🎳','🎫','🎟','🏆','🥇','🥈','🥉','🏅','🎖','🎗'
    ],
    travel: [
      '🚗','🚕','🚙','🚌','🏎','🚓','🚑','🚒','🚐','🚚','🚛','🚜','🚲','🛴','🛵','🏍','🚨','🚆','🚇','🚉','✈️','🛫','🛬','🛩','💺','🛰','🚀','🛸','🚁','🚟','🚠','🚡','🛶','⛵','🛥','🚤','🛳','⛴','🚢','⚓','🚧','⛽','🏣','🏤','🏥','🏦','🏨','🏩','🏪','🏫','🏬','🏭','🏯','🏰','💒','🗼','🗽','⛪','🕌','🕍','⛩','🕋','⛲','⛺','🌁','🌉','🌋','⛰','🏔','🗻','🏕','🏖','🏜','🏝','🏞','🏟','🏠','🏡','🏢','🏘','🏙','🌆','🌅','🌄','🌇','🌃','🌌','🎠','🎡','🎢'
    ],
    objects: [
      '⌚','📱','💻','⌨','🖱','💿','📷','📹','📼','🕯','💡','🔦','🏮','📕','📖','📚','📓','📜','📄','📰','🏷','💰','🪙','💵','💳','🧾','✉️','📧','📥','📦','📫','📮','✏️','✒️','🖌','🖍','📝','💼','📁','📅','📈','📋','📌','📍','📎','✂️','🗄','🗑','🔒','🔓','🔑','🔨','🪓','⛏','⚔️','🛡️','🔧','🔩','⚙️','⚖️','🔗','⛓️','🧰','🧲','🧪','🧫','🔬','🔭','📡','💉','🩸','💊','🩹','🩺','🚪','🪞','🪟','🛏️','🪑','🚽','🚿','🛁','🪒','🧹','🧺','🧼','🧽','🪣'
    ],
    symbols: [
      '💘','💝','💖','💗','💓','💞','💕','💟','❣️','💔','❤️','🧡','💛','💚','💙','💜','🤎','🖤','🤍','💯','💢','💬','💭','💤','♨️','🛑','🚫','📛','🔇','🔈','🔉','🔊','🔔','🔕','📣','📢','➕','➖','✖️','➗','💲'
    ],
    flags: [
      '🎌','🏁','🏳️','🏴','🏳️‍🌈','🏴‍☠️','🇫🇷','🇬🇧','🇺🇸','🇨🇦','🇯🇵','🇩🇪','🇮🇹','🇪🇸','🇷🇺','🇨🇳','🇧🇷','🇮🇳'
    ]
  };

  const filteredEmojis = $derived.by(() => {
    const term = search.trim().toLowerCase();
    if (!term) {
      return emojiMap[activeTab] || [];
    }
    const results: string[] = [];
    for (const key of Object.keys(emojiMap)) {
      results.push(...emojiMap[key].filter(e => e.includes(term)));
    }
    return [...new Set(results)].slice(0, 80);
  });

  /** Recherche par nom : le seul critère exploitable sur un emoji custom. */
  const filteredServerEmojis = $derived.by(() => {
    const all = emojiSet?.emojis ?? [];
    const term = search.trim().toLowerCase();
    const usable = all.filter((e) => e.available);
    return term ? usable.filter((e) => e.name.toLowerCase().includes(term)) : usable;
  });

  const acceptAttr = GUILD_EMOJI_ACCEPTED.join(',');
  const maxKb = Math.round(GUILD_EMOJI_MAX_BYTES / 1024);

  async function loadServerEmojis(force = false) {
    if (loadingServer || (emojiSet && !force)) return;
    loadingServer = true;
    serverError = '';
    try {
      const result = await fetchGuildEmojis();
      // `null` = aucun serveur sélectionné : l'onglet le dit plutôt que de
      // rester sur un chargement qui n'aboutira jamais.
      emojiSet = result;
      if (!result) serverError = m.d1_emoji_server_unavailable();
    } catch (err) {
      serverError = err instanceof Error ? err.message : m.d1_emoji_server_unavailable();
    } finally {
      loadingServer = false;
    }
  }

  function selectEmoji(emoji: string) {
    value = emoji;
    isOpen = false;
  }

  function selectServerEmoji(emoji: GuildEmoji) {
    selectEmoji(format === 'id' ? emoji.id : emoji.mention);
  }

  function pickFile(file: File | null | undefined) {
    if (!file) return;
    if (!GUILD_EMOJI_ACCEPTED.includes(file.type)) {
      toast.error(m.d1_emoji_upload_bad_format());
      return;
    }
    if (file.size > GUILD_EMOJI_MAX_BYTES) {
      toast.error(m.d1_emoji_upload_too_big({ max: String(maxKb) }));
      return;
    }
    uploadFile = file;
    // Le nom du fichier est presque toujours le nom voulu : le proposer évite
    // une saisie, et il reste modifiable avant l'envoi.
    uploadName = sanitizeEmojiName(file.name.replace(/\.[^.]+$/, ''));
    URL.revokeObjectURL(uploadPreview);
    uploadPreview = URL.createObjectURL(file);
  }

  function clearUpload() {
    if (uploadPreview) URL.revokeObjectURL(uploadPreview);
    uploadFile = null;
    uploadName = '';
    uploadPreview = '';
    if (fileInput) fileInput.value = '';
  }

  async function submitUpload() {
    if (!uploadFile || uploading) return;
    uploading = true;
    try {
      const result = await uploadGuildEmoji(uploadFile, uploadName);
      emojiSet = result;
      clearUpload();
      // L'emoji vient d'être créé pour être utilisé : le choisir tout de suite
      // évite d'aller le rechercher dans l'onglet d'à côté.
      if (result.created) {
        toast.success(m.d1_emoji_upload_done({ name: result.created.name }));
        selectServerEmoji(result.created);
      } else {
        activeSource = 'server';
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : m.d1_emoji_upload_failed());
    } finally {
      uploading = false;
    }
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    dragOver = false;
    pickFile(event.dataTransfer?.files?.[0]);
  }

  function handleOutsideClick(event: MouseEvent) {
    if (isOpen && pickerEl && !pickerEl.contains(event.target as Node)) {
      isOpen = false;
    }
  }

  function togglePicker() {
    isOpen = !isOpen;
    if (isOpen) {
      search = '';
      void loadServerEmojis();
    }
  }

  $effect(() => {
    if (isOpen) {
      document.addEventListener('click', handleOutsideClick, true);
    } else {
      document.removeEventListener('click', handleOutsideClick, true);
    }
    return () => {
      document.removeEventListener('click', handleOutsideClick, true);
    };
  });

  // Un aperçu local survit à la fermeture du sélecteur : sans ceci, chaque
  // image déposée laisserait son blob en mémoire jusqu'au rechargement.
  $effect(() => () => {
    if (uploadPreview) URL.revokeObjectURL(uploadPreview);
  });
</script>

<div class="relative inline-flex items-center shrink-0" bind:this={pickerEl}>
  <button
    type="button"
    {disabled}
    onclick={togglePicker}
    class="flex h-11 w-11 items-center justify-center rounded-lg bg-surface-container-high/60 border border-outline-variant/10 hover:bg-surface-container-high hover:border-outline-variant/35 text-xl transition-all cursor-pointer shadow-sm disabled:opacity-40 disabled:cursor-not-allowed select-none active:scale-95"
    title={m.d1_emoji_open_picker()}
  >
    😀
  </button>

  {#if isOpen}
    <div
      class="absolute right-0 bottom-full mb-2 z-100 w-72 bg-surface border border-outline-variant/20 rounded-xl p-4 shadow-sm flex flex-col gap-3 animate-in fade-in slide-in-from-bottom-2 duration-150"
    >
      <div class="flex gap-1 p-1 rounded-lg bg-surface-container-low border border-outline-variant/10">
        {#each [
          { id: 'server', label: m.d1_emoji_source_server(), icon: 'server' },
          { id: 'unicode', label: m.d1_emoji_source_unicode(), icon: 'emoji' },
          { id: 'upload', label: m.d1_emoji_source_upload(), icon: 'upload' }
        ] as source}
          <button
            type="button"
            onclick={() => { activeSource = source.id as typeof activeSource; search = ''; }}
            class="flex-1 px-2 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all {activeSource === source.id ? 'bg-primary/15 text-primary' : 'text-on-surface-variant/60 hover:text-on-surface'}"
          >
            {source.label}
          </button>
        {/each}
      </div>

      {#if activeSource !== 'upload'}
        <input
          type="text"
          placeholder={m.d1_emoji_search()}
          bind:value={search}
          class="w-full bg-surface-container-low border border-outline-variant/15 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/30 text-on-surface"
        />
      {/if}

      {#if activeSource === 'server'}
        {#if loadingServer}
          <div class="py-6 text-center text-[10px] text-on-surface-variant/40 italic">{m.d1_emoji_server_loading()}</div>
        {:else if serverError}
          <div class="py-4 text-center text-[10px] text-error">{serverError}</div>
        {:else}
          <div class="grid grid-cols-6 gap-1 max-h-40 overflow-y-auto pr-1 scrollbar-thin select-none">
            {#each filteredServerEmojis as emoji (emoji.id)}
              <button
                type="button"
                onclick={() => selectServerEmoji(emoji)}
                title=":{emoji.name}:"
                class="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-primary/10 active:scale-95 transition-all cursor-pointer"
              >
                <img src={emoji.url} alt=":{emoji.name}:" class="h-6 w-6 object-contain" loading="lazy" />
              </button>
            {:else}
              <div class="col-span-6 text-center text-[10px] text-on-surface-variant/40 italic py-4">
                {m.d1_emoji_server_empty()}
              </div>
            {/each}
          </div>
          {#if emojiSet}
            <div class="flex items-center justify-between text-[10px] text-on-surface-variant/50">
              <span>{m.d1_emoji_server_slots({
                used: String(emojiSet.slots.staticUsed),
                total: String(emojiSet.slots.total)
              })}</span>
              {#if emojiSet.canUpload}
                <button type="button" class="text-primary hover:underline" onclick={() => activeSource = 'upload'}>
                  {m.d1_emoji_source_upload()}
                </button>
              {/if}
            </div>
          {/if}
        {/if}
      {:else if activeSource === 'unicode'}
        {#if !search.trim()}
          <div class="flex gap-1 overflow-x-auto pb-1 scrollbar-hide select-none">
            {#each categories as cat}
              <button
                type="button"
                onclick={() => activeTab = cat.id}
                class="p-1 rounded-lg hover:bg-surface-container-high/40 text-sm transition-all shrink-0 {activeTab === cat.id ? 'bg-primary/15 text-primary border border-primary/10' : ''}"
                title={cat.name}
              >
                {cat.icon}
              </button>
            {/each}
          </div>
        {/if}

        <div class="grid grid-cols-6 gap-1 max-h-40 overflow-y-auto pr-1 scrollbar-thin text-xl select-none">
          {#each filteredEmojis as emoji}
            {#if emoji.trim()}
              <button
                type="button"
                onclick={() => selectEmoji(emoji)}
                class="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-primary/10 active:scale-95 transition-all cursor-pointer"
              >
                {emoji}
              </button>
            {/if}
          {/each}
          {#if filteredEmojis.filter(e => e.trim()).length === 0}
            <div class="col-span-6 text-center text-[10px] text-on-surface-variant/40 italic py-4">
              {m.d1_emoji_none()}
            </div>
          {/if}
        </div>
      {:else}
        {#if emojiSet && !emojiSet.canUpload}
          <div class="py-4 text-center text-[10px] text-on-surface-variant/50 leading-relaxed">
            {m.d1_emoji_upload_forbidden()}
          </div>
        {:else}
          <input
            bind:this={fileInput}
            type="file"
            accept={acceptAttr}
            class="hidden"
            onchange={(e) => pickFile((e.currentTarget as HTMLInputElement).files?.[0])}
          />

          {#if uploadFile}
            <div class="flex items-center gap-3 p-2 rounded-lg bg-surface-container-low border border-outline-variant/10">
              <img src={uploadPreview} alt="" class="h-10 w-10 object-contain rounded" />
              <div class="min-w-0 flex-1">
                <input
                  type="text"
                  bind:value={uploadName}
                  oninput={(e) => uploadName = sanitizeEmojiName((e.currentTarget as HTMLInputElement).value)}
                  maxlength="32"
                  placeholder={m.d1_emoji_upload_name()}
                  class="w-full bg-transparent border-b border-outline-variant/20 pb-1 text-xs focus:outline-none focus:border-primary text-on-surface"
                />
                <span class="text-[10px] text-on-surface-variant/40">{Math.round(uploadFile.size / 1024)} Ko</span>
              </div>
              <button type="button" onclick={clearUpload} class="text-on-surface-variant/40 hover:text-error" title={m.d1_emoji_upload_clear()}>
                <Papicon icon="x" size={14} />
              </button>
            </div>
            <button
              type="button"
              class="btn btn-primary btn-sm w-full"
              disabled={uploading || uploadName.trim().length < 2}
              onclick={submitUpload}
            >
              {uploading ? m.d1_emoji_upload_pending() : m.d1_emoji_upload_submit()}
            </button>
          {:else}
            <button
              type="button"
              onclick={() => fileInput?.click()}
              ondragover={(e) => { e.preventDefault(); dragOver = true; }}
              ondragleave={() => dragOver = false}
              ondrop={handleDrop}
              class="flex flex-col items-center justify-center gap-2 w-full py-6 rounded-xl border border-dashed transition-all {dragOver ? 'border-primary bg-primary/5' : 'border-outline-variant/25 hover:border-outline-variant/50'}"
            >
              <Papicon icon="upload" size={20} class="text-on-surface-variant/50" />
              <span class="text-[11px] text-on-surface-variant/70">{m.d1_emoji_upload_drop()}</span>
              <span class="text-[10px] text-on-surface-variant/40">{m.d1_emoji_upload_hint({ max: String(maxKb) })}</span>
            </button>
          {/if}
        {/if}
      {/if}
    </div>
  {/if}
</div>
