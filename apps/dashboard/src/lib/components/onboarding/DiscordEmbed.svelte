<script lang="ts">
  /**
   * Un embed Discord, tel que le bot le publiera.
   *
   * La barre de couleur a gauche est ce qui rend le choix de teinte lisible :
   * une pastille dans un selecteur ne dit pas a quoi ressemblera le panneau
   * poste dans le salon, et c'est pourtant la seule question qu'on se pose en
   * choisissant une couleur.
   */
  import EmojiText from '../EmojiText.svelte';

  const {
    color,
    title,
    description,
    fields = [],
    buttons = [],
  }: {
    color: string;
    title?: string;
    description?: string;
    fields?: { emoji?: string | null; name: string; value?: string | null }[];
    buttons?: { emoji?: string | null; label: string }[];
  } = $props();
</script>

<div class="mt-1.5 flex rounded-[4px] overflow-hidden bg-[#2b2d31] max-w-[440px]">
  <div class="w-1 shrink-0" style="background-color: {color}"></div>
  <div class="min-w-0 flex-1 px-3.5 py-3">
    {#if title}
      <p class="text-[15px] font-semibold text-[#f2f3f5] leading-snug"><EmojiText value={title} /></p>
    {/if}
    {#if description}
      <p class="mt-1 text-[13.5px] leading-[1.4] text-[#dbdee1] whitespace-pre-wrap break-words"><EmojiText value={description} /></p>
    {/if}

    {#if fields.length}
      <div class="mt-2.5 space-y-2">
        {#each fields as field, index (index)}
          <div>
            <p class="text-[13.5px] font-semibold text-[#f2f3f5]">
              {#if field.emoji}<span class="mr-1"><EmojiText value={field.emoji} /></span>{/if}{field.name}
            </p>
            {#if field.value}
              <p class="text-[13px] leading-[1.4] text-[#b5bac1] whitespace-pre-wrap break-words"><EmojiText value={field.value} /></p>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

{#if buttons.length}
  <!-- Les boutons vivent sous l'embed, pas dedans : c'est la place que Discord
       leur donne, et l'apercu perdrait son interet a la deplacer. -->
  <div class="mt-2 flex flex-wrap gap-2 max-w-[440px]">
    {#each buttons as button, index (index)}
      <span
        class="inline-flex items-center gap-1.5 rounded-[3px] px-3 py-1.5 text-[13px] font-medium text-white"
        style="background-color: {color}"
      >
        {#if button.emoji}<span><EmojiText value={button.emoji} /></span>{/if}
        {button.label}
      </span>
    {/each}
  </div>
{/if}
