<script lang="ts">
  /**
   * A quoi sert ce serveur.
   *
   * La reponse decide des sections de la maquette a retenir - salons a poser,
   * modules a allumer - et des motifs de ticket coches d'office a l'ecran
   * suivant. Elle precede donc la structure, et de peu : c'est la derniere
   * question avant que Kotbo n'ecrive quoi que ce soit sur Discord.
   *
   * L'apercu montre l'arborescence que la vocation retenue produirait. Quatre
   * cartes qui se ressemblent ne se departagent pas ; quatre cartes dont on
   * voit le resultat, si.
   */
  import { wizard } from '../../../stores/onboardingWizard.svelte';
  import { onboardingData } from '../../../stores/onboardingData.svelte';
  import { THEMES, celebrateStep, selectionFor, type ThemeKey } from '../../../onboarding';
  import ChoiceCard from '../ChoiceCard.svelte';
  import Papicon from '../../Papicon.svelte';
  import WizardShell from '../WizardShell.svelte';

  const { onEditTracks }: { onEditTracks: () => void } = $props();

  const kind = $derived(wizard.kind ?? 'new');
  const theme = $derived<ThemeKey>(wizard.theme ?? 'communaute');
  const template = $derived(onboardingData.template);

  /**
   * L'arborescence, telle que la vocation la dessine.
   *
   * On la lit sur la maquette complete plutot que sur la selection reelle :
   * l'apercu doit montrer ce que la vocation propose, categories et salons
   * confondus. Mais sur un serveur habite, la montrer telle quelle - sans dire
   * ce qui existe deja - la fait passer pour une maquette generique sans
   * rapport avec le vrai serveur : c'est ce qui remonte comme « c'est pas ma
   * structure ». Ce que `present` reconnait est donc marque a part, comme sur
   * l'ecran de structure.
   */
  const tree = $derived.by(() => {
    if (!template) return [];
    const already = new Set(template.present ?? []);
    const keys = new Set(selectionFor(template.plan, 'new', theme));
    const items = template.plan.filter((item) => keys.has(item.key) && item.kind !== 'module');
    const categories = items.filter((item) => item.kind === 'category');
    return categories.map((category) => ({
      key: category.key,
      name: category.name,
      already: already.has(category.key),
      children: items
        .filter((item) => item.parent === category.key)
        .map((item) => ({
          key: item.key,
          name: item.name,
          voice: item.kind === 'voice',
          already: already.has(item.key),
        })),
    }));
  });

  const rows = $derived(tree.flatMap((category) => category.children));
  const totalCount = $derived(rows.length);
  const alreadyCount = $derived(rows.filter((row) => row.already).length);
</script>

<WizardShell
  title="À quoi sert ce serveur ?"
  lead={kind === 'existing'
    ? "La réponse décide de ce que Kotbo complète et des modules à allumer."
    : "La réponse décide des salons à poser et des modules à allumer."}
  {onEditTracks}
>
  <div class="space-y-3">
    {#each THEMES as entry (entry.key)}
      <ChoiceCard
        label={entry.label}
        pitch={entry.pitch}
        icon={entry.icon}
        selected={theme === entry.key}
        onclick={() => { wizard.answer({ theme: entry.key }); celebrateStep(); }}
      />
    {/each}
  </div>

  {#snippet preview()}
    <div class="rounded-xl overflow-hidden border border-black/25 shadow-sm bg-[#2b2d31]">
      <div class="px-3.5 py-2.5 border-b border-black/25 flex items-center gap-2">
        <Papicon icon="layout-grid" size={12} class="text-[#80848e]" />
        <span class="text-[12.5px] font-semibold text-[#dbdee1]">
          {kind === 'existing' ? 'Votre serveur, complété' : "L'arborescence proposée"}
        </span>
      </div>

      <div class="px-2 py-2 max-h-[420px] overflow-y-auto">
        {#each tree as category (category.key)}
          <p class="px-2 pt-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-[#949ba4]">
            {category.name}
            {#if category.already}<span class="ml-1 font-medium normal-case tracking-normal text-[#6d7178]">— déjà là</span>{/if}
          </p>
          {#each category.children as channel (channel.key)}
            <p class="flex items-center gap-1.5 rounded px-2 py-0.5 text-[13px] {channel.already ? 'text-[#80848e]' : 'text-[#dbdee1]'}">
              <span class="text-[#80848e] text-[14px] leading-none shrink-0">
                {channel.voice ? '🔊' : '#'}
              </span>
              <span class="truncate">{channel.name}</span>
              {#if channel.already}
                <span class="ml-auto shrink-0 text-[10.5px] text-[#6d7178]">déjà là</span>
              {/if}
            </p>
          {/each}
        {:else}
          <p class="px-2 py-6 text-center text-[12.5px] text-[#949ba4]">
            Lecture de la maquette…
          </p>
        {/each}
      </div>

      {#if kind === 'existing' && alreadyCount > 0}
        <!-- Sans cette ligne, la liste se lit comme une maquette generique posee
             par-dessus le serveur - « c'est pas ma structure ». Elle dit ce que
             la teinte grise veut dire : ce qui est deja la reste tel quel. -->
        <p class="px-3.5 py-2.5 border-t border-black/25 text-[11.5px] leading-relaxed text-[#949ba4]">
          {alreadyCount} de ces {totalCount} entrées existent déjà chez vous : Kotbo s'y branche
          sans les renommer ni les déplacer. Vous confirmerez ligne par ligne juste après.
        </p>
      {/if}
    </div>
  {/snippet}

  {#snippet footer()}
    <button
      type="button"
      onclick={() => { wizard.answer({ theme }); wizard.complete('theme'); }}
      class="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-on-primary text-sm font-semibold hover:opacity-90 transition-opacity"
    >
      Continuer
      <Papicon icon="ChevronRight" size={15} />
    </button>
  {/snippet}
</WizardShell>
