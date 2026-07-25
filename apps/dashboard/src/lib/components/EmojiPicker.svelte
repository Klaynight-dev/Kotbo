<script lang="ts">
  import { m } from '../i18n';

  let {
    value = $bindable(''),
    disabled = false
  }: {
    value: string;
    disabled?: boolean;
  } = $props();

  let isOpen = $state(false);
  let search = $state('');
  let activeTab = $state('smileys');
  let pickerEl = $state<HTMLDivElement | null>(null);

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
      '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐽','🐸','🐵','🙈','🙉','🙊','🐒','🐔','🐧','🐦','🐤','🐣','🐥','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐜','🕷','🕸','蠍','🐢','🐍','🦎','🐙','🦑','🦞','🦀','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🐊','🐆','🐅','🐃','🐂','🐄','🐪','🐫','🦙','🐘','🦣','🦏','🦛','🐐','🐏','🐑','🐎','🐖','🦌','🐕','🐩','🐈','🐈‍⬛','🐓','🦃','🦚','🦩','🦢','🕊','🐇','🐿','🦫','🦡','🦥','🦦','🦨','🦘','🌲','🌳','🌴','🌵','🌱','🌿','🍀','🍁','🍂','🍃','🌸','🌹','🌺','🌻','🌼','🌷'
    ],
    food: [
      '🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌶','🫑','🧅','🧄','🥔','🥕','🌽','🍄','🌰','🥜','🍞','🥐','🥖','🥨','🥯','🥞','🧇','🧀','🍖','🍗','🥩','🥓','🍔','🍟','🍕','🌭','🥪','🌮','🌯','🍳','🥘','🍲','🥣','🥗','🍿','🧈','🧂','🥫','🍱','🍘','🍙','🍚','🍛','🍜','🍝','🍠','🍢','🍣','🍤','🍥','🥮','🍡','🥟','🍪','🎂','🍰','🧁','🥧','🍫','🍬','🍭','🍮','🍯','🍼','🥛','☕','🫖','🍵','🍶','🍷','🍸','🍹','🍺','🍻','🥂','🥃','🥤','🧋','🧃','🧉','🧊'
    ],
    activities: [
      '⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🪀','🏓','🏸','🏒','⛳','🏹','🎣','🥊','🥋','⛸','🛷','🥌','🎯','🪂','🪁','🎮','🕹','🎰','🎲','🧩','♟','🎭','🎨','🎬','🎤','🎧','🎼','🎹','🥁','🎷','🎺','🎸','🪕','🎻','🎳','🎫','🎟','🏆','🥇','🥈','🥉','🏅','🎖','🎗'
    ],
    travel: [
      '🚗','🚕','🚙','🚌','🏎','🚓','🚑','🚒','🚐','🚚','🚛','🚜','🚲','🛴','🛵','🏍','🚨','🚆','🚇','🚉','✈️','🛫','🛬','🛩','💺','🛰','🚀','🛸','🚁','🚟','🚠','🚡','🛶','⛵','🛥','🚤','🛳','⛴','🚢','⚓','🚧','⛽','🏣','🏤','🏥','🏦','🏨','🏩','🏪','🏫','🏬','🏭','🏯','🏰','💒','🗼','🗽','⛪','🕌','🕍','⛩','🕋','⛲','⛺','🌁','🌉','Volcano','⛰','🏔','🗻','🏕','🏖','🏜','🏝','🏞','🏟','🏠','🏡','🏢','🏘','🏙','🌆','🌅','🌄','🌇','🌃','🌌','Bridge','🎠','🎡','🎢'
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
    let results: string[] = [];
    for (const key of Object.keys(emojiMap)) {
      results.push(...emojiMap[key].filter(e => e.includes(term)));
    }
    return [...new Set(results)].slice(0, 80);
  });

  function selectEmoji(emoji: string) {
    value = emoji;
    isOpen = false;
  }

  function handleOutsideClick(event: MouseEvent) {
    if (isOpen && pickerEl && !pickerEl.contains(event.target as Node)) {
      isOpen = false;
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
</script>

<div class="relative inline-flex items-center shrink-0" bind:this={pickerEl}>
  <button
    type="button"
    {disabled}
    onclick={() => isOpen = !isOpen}
    class="flex h-11 w-11 items-center justify-center rounded-lg bg-surface-container-high/60 border border-outline-variant/10 hover:bg-surface-container-high hover:border-outline-variant/35 text-xl transition-all cursor-pointer shadow-sm disabled:opacity-40 disabled:cursor-not-allowed select-none active:scale-95"
    title={m.d1_emoji_open_picker()}
  >
    😀
  </button>

  {#if isOpen}
    <div
      class="absolute right-0 bottom-full mb-2 z-100 w-64 bg-surface border border-outline-variant/20 rounded-xl p-4 shadow-sm flex flex-col gap-3 animate-in fade-in slide-in-from-bottom-2 duration-150"
    >
      <input
        type="text"
        placeholder={m.d1_emoji_search()}
        bind:value={search}
        class="w-full bg-surface-container-low border border-outline-variant/15 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/30 text-on-surface"
      />

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
    </div>
  {/if}
</div>
