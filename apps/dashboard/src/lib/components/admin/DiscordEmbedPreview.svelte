<script lang="ts">
  /**
   * Aperçu fidèle de l'embed tel que Discord l'affichera.
   *
   * L'ancien aperçu rendait l'image même quand elle était incompatible, ce qui
   * donnait exactement le faux positif à l'origine du bug signalé : ça marche
   * dans le dashboard, ça casse dans Discord. Ici, une image que Discord ne
   * saura pas charger est rendue comme Discord la rend - en cadre d'échec.
   */
  import Papicon from '../Papicon.svelte';

  const {
    title = '',
    message = '',
    color = '#5865F2',
    imageUrl = '',
    thumbnailUrl = '',
    footerText = '',
    botName = 'Kotbo',
    botAvatar = '',
    renderEmoji = (text: string) => text,
    renderTitle = (text: string) => text,
  }: {
    title?: string;
    message?: string;
    color?: string;
    imageUrl?: string;
    thumbnailUrl?: string;
    footerText?: string;
    botName?: string;
    botAvatar?: string;
    /** Convertit les raccourcis `:nom:` en `<img>` (description). */
    renderEmoji?: (text: string) => string;
    /** Convertit les raccourcis en équivalent unicode (titre et pied de page). */
    renderTitle?: (text: string) => string;
  } = $props();

  let imageBroken = $state(false);
  let thumbBroken = $state(false);

  /** Une URL que Discord refusera de charger : inutile d'en tenter le rendu. */
  function isUnloadable(url: string): boolean {
    const value = url.trim();
    if (!value) return false;
    if (value.startsWith('data:')) return true;
    try {
      const parsed = new URL(value);
      const isDiscordCdn = /(^|\.)cdn\.discordapp\.com$/.test(parsed.hostname)
        || /(^|\.)media\.discordapp\.net$/.test(parsed.hostname);
      return isDiscordCdn && parsed.searchParams.has('ex') && parsed.searchParams.has('hm');
    } catch {
      return true;
    }
  }

  const imageFails = $derived(Boolean(imageUrl.trim()) && (isUnloadable(imageUrl) || imageBroken));
  const thumbFails = $derived(Boolean(thumbnailUrl.trim()) && (isUnloadable(thumbnailUrl) || thumbBroken));

  $effect(() => { void imageUrl; imageBroken = false; });
  $effect(() => { void thumbnailUrl; thumbBroken = false; });

  const now = new Date().toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
</script>

<!-- Fond Discord : la couleur de l'embed doit être jugée sur le vrai fond -->
<div class="rounded-xl bg-[#313338] p-4 font-sans">
  <div class="flex gap-3">
    <div class="w-10 h-10 shrink-0 rounded-full bg-[#5865F2] overflow-hidden flex items-center justify-center">
      {#if botAvatar}
        <img src={botAvatar} alt="" class="w-full h-full object-cover" />
      {:else}
        <Papicon icon="Bot" size={18} class="text-white" />
      {/if}
    </div>

    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2 mb-1">
        <span class="text-[15px] font-medium text-white">{botName}</span>
        <span class="px-1 py-px rounded bg-[#5865F2] text-[10px] font-semibold text-white uppercase leading-tight">APP</span>
        <span class="text-[11px] text-[#949BA4]">{now}</span>
      </div>

      <!-- Embed -->
      <div class="max-w-[520px] rounded border-l-4 bg-[#2B2D31] overflow-hidden" style="border-color: {color}">
        <div class="p-3.5 flex gap-3">
          <div class="min-w-0 flex-1">
            {#if title}
              <p class="text-[16px] font-semibold text-white leading-snug mb-2 break-words">
                {@html renderTitle(title)}
              </p>
            {/if}

            {#if message}
              <div class="text-[14px] text-[#DBDEE1] leading-[1.375] whitespace-pre-wrap break-words">
                {@html renderEmoji(message)}
              </div>
            {:else}
              <p class="text-[14px] text-[#949BA4] italic">Le message apparaîtra ici…</p>
            {/if}
          </div>

          {#if thumbnailUrl.trim()}
            <div class="shrink-0 w-20 h-20">
              {#if thumbFails}
                <div class="w-full h-full rounded bg-[#232428] border border-[#3F4147] flex flex-col items-center justify-center gap-1 px-1 text-center">
                  <Papicon icon="ImageOff" size={14} class="text-[#949BA4]" />
                  <span class="text-[9px] text-[#949BA4] leading-tight">Échec</span>
                </div>
              {:else}
                <img
                  src={thumbnailUrl}
                  alt=""
                  onerror={() => (thumbBroken = true)}
                  class="w-full h-full object-cover rounded"
                />
              {/if}
            </div>
          {/if}
        </div>

        {#if imageUrl.trim()}
          <div class="px-3.5 pb-3.5">
            {#if imageFails}
              <!-- Reproduit littéralement ce que Discord affiche -->
              <div class="w-full h-40 rounded bg-[#232428] border border-[#3F4147] flex flex-col items-center justify-center gap-2">
                <Papicon icon="ImageOff" size={26} class="text-[#949BA4]" />
                <span class="text-[13px] text-[#949BA4]">Échec du chargement de l’image.</span>
              </div>
            {:else}
              <img
                src={imageUrl}
                alt=""
                onerror={() => (imageBroken = true)}
                class="w-full max-h-72 object-cover rounded"
              />
            {/if}
          </div>
        {/if}

        {#if footerText}
          <div class="px-3.5 pb-3.5 flex items-center gap-2 text-[12px] text-[#949BA4]">
            <span class="break-words">{@html renderTitle(footerText)}</span>
            <span>•</span>
            <span>{now}</span>
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>
