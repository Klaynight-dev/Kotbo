<script lang="ts">
  /**
   * La rencontre : le bot et le serveur, cote a cote.
   *
   * C'est la seule image du parcours, et elle dit ce qui vient de se passer
   * mieux qu'une phrase. Quelqu'un qui vient d'inviter Kotbo ne sait pas encore
   * a quoi ressemble ce qu'il installe.
   *
   * Les quatre promesses en dessous ne sont pas un argumentaire : elles disent
   * ce que les ecrans suivants vont reellement produire, pour qu'on sache ce
   * qu'on s'apprete a traverser.
   */
  import { authStore } from '../../../stores/auth.svelte';
  import { wizard } from '../../../stores/onboardingWizard.svelte';
  import KotboMark from '../KotboMark.svelte';
  import Papicon from '../../Papicon.svelte';
  import WizardShell from '../WizardShell.svelte';

  const selectedGuild = $derived(
    authStore.guilds.find((guild) => guild.id === authStore.selectedGuildId)
  );

  const guildIconUrl = $derived(
    selectedGuild?.icon
      ? `https://cdn.discordapp.com/icons/${selectedGuild.id}/${selectedGuild.icon}.png?size=128`
      : null
  );

  const PROMISES = [
    { icon: 'layout-grid', title: 'Une structure complète', text: "Salons, catégories, rôles et permissions cohérents, posés d'un coup." },
    { icon: 'shield', title: 'Une modération réglée', text: 'Filtres de messages et seuils anti-raid, au niveau que vous choisissez.' },
    { icon: 'door-open', title: 'Un accueil préparé', text: "Message de bienvenue, règlement publié, rôles à l'arrivée." },
    { icon: 'sparkles', title: 'Et tout le reste, au choix', text: "Économie, quêtes, journaux, pilotage par IA : vous cochez ce qui vous intéresse." },
  ];
</script>

<WizardShell bare>
  <div class="flex flex-col items-center text-center">
    <div class="flex items-center gap-4 sm:gap-5">
      <KotboMark size={72} halo />
      <Papicon icon="plus" size={18} class="text-on-surface-variant/35" />
      {#if guildIconUrl}
        <img src={guildIconUrl} alt="" class="w-[72px] h-[72px] rounded-[22%] object-cover" />
      {:else}
        <div class="w-[72px] h-[72px] rounded-[22%] bg-surface-container flex items-center justify-center text-xl font-bold text-on-surface-variant/60">
          {(selectedGuild?.name ?? '?').slice(0, 1).toUpperCase()}
        </div>
      {/if}
    </div>

    <h1 class="mt-7 text-2xl sm:text-[30px] leading-tight font-semibold tracking-tight text-on-surface font-headline">
      Kotbo est arrivé sur {selectedGuild?.name ?? 'votre serveur'}.
    </h1>
    <p class="mt-3 max-w-lg text-[15px] text-on-surface-variant/75 leading-relaxed">
      Quelques questions, et votre serveur est monté, protégé et prêt à accueillir.
      Vous choisirez vous-même ce qu'on configure - et vous pourrez tout ajuster ensuite.
    </p>

    <div class="mt-4 inline-flex items-center gap-2 rounded-full border border-outline-variant/35 bg-surface-container-low/40 px-3 py-1.5">
      <Papicon icon="clock" size={13} class="text-primary" />
      <span class="text-[12.5px] font-medium text-on-surface-variant/70">À partir de 3 minutes</span>
    </div>
  </div>

  <ul class="mt-9 grid gap-3 sm:grid-cols-2">
    {#each PROMISES as row (row.title)}
      <li class="rounded-2xl border border-outline-variant/30 bg-surface-container-low/30 p-4">
        <div class="w-9 h-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center mb-2.5">
          <Papicon icon={row.icon} size={16} />
        </div>
        <p class="text-[14px] font-semibold text-on-surface">{row.title}</p>
        <p class="mt-1 text-[13px] text-on-surface-variant/65 leading-relaxed">{row.text}</p>
      </li>
    {/each}
  </ul>

  {#snippet footer()}
    <button
      type="button"
      onclick={() => wizard.next()}
      class="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-on-primary text-sm font-semibold hover:opacity-90 transition-opacity"
    >
      Commencer
      <Papicon icon="ChevronRight" size={15} />
    </button>
  {/snippet}
</WizardShell>
