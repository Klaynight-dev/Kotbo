<script lang="ts">
  /**
   * La langue du serveur, et son fuseau.
   *
   * La langue vaut pour tout ce que le bot ecrit - ses reponses, ses panneaux,
   * et le nom des salons qu'il va poser. C'est pour cette derniere raison
   * qu'elle precede la structure : changer de langue apres la pose laisserait
   * un `#rules` au milieu d'un serveur francais.
   *
   * L'apercu montre les noms de salons dans la langue retenue. C'est l'effet le
   * plus visible du choix, et le montrer evite d'avoir a l'expliquer.
   */
  import { m } from '../../../i18n';
  import { toast } from '../../../stores/toast.svelte';
  import { wizard } from '../../../stores/onboardingWizard.svelte';
  import { onboardingData } from '../../../stores/onboardingData.svelte';
  import { COMMON_TIMEZONES, celebrateStep } from '../../../onboarding';
  import {
    fetchGuildLanguage,
    fetchGuildTimezone,
    updateGuildLanguage,
    updateGuildTimezone,
  } from '../../../api';
  import Papicon from '../../Papicon.svelte';
  import WizardShell from '../WizardShell.svelte';

  const { onEditTracks }: { onEditTracks: () => void } = $props();

  let language = $state<'fr' | 'en'>('fr');
  let timezone = $state('Europe/Paris');
  /** Ce qui etait en vigueur avant l'ecran : rien n'est reecrit si rien ne bouge. */
  let savedLanguage = $state<'fr' | 'en'>('fr');
  let savedTimezone = $state('Europe/Paris');
  let loaded = $state(false);

  const OPTIONS = [
    { key: 'fr' as const, label: 'Français', flag: '🇫🇷', samples: ['#règlement', '#bienvenue', '#général'] },
    { key: 'en' as const, label: 'English', flag: '🇬🇧', samples: ['#rules', '#welcome', '#general'] },
  ];

  const samples = $derived(OPTIONS.find((option) => option.key === language)?.samples ?? []);

  /** L'heure qu'il est dans le fuseau retenu, pour verifier d'un coup d'oeil. */
  const localTime = $derived.by(() => {
    try {
      return new Intl.DateTimeFormat('fr-FR', {
        hour: '2-digit', minute: '2-digit', timeZone: timezone,
      }).format(new Date());
    } catch {
      return null;
    }
  });

  $effect(() => {
    if (loaded) return;
    loaded = true;
    void (async () => {
      const [lang, zone] = await Promise.all([
        fetchGuildLanguage().catch(() => null),
        fetchGuildTimezone().catch(() => null),
      ]);
      if (lang?.locale) { language = lang.locale; savedLanguage = lang.locale; }
      if (zone?.timezone) { timezone = zone.timezone; savedTimezone = zone.timezone; }
    })();
  });

  async function apply() {
    if (onboardingData.busy) return;
    onboardingData.busy = true;
    try {
      if (language !== savedLanguage) {
        await updateGuildLanguage({ language }, undefined, { silent: true });
        savedLanguage = language;
        // La maquette est nommee dans la langue du serveur : sans relecture,
        // l'ecran « structure » annoncerait des salons dans l'ancienne.
        await onboardingData.refreshTemplate();
      }
      if (timezone !== savedTimezone) {
        await updateGuildTimezone(timezone, undefined, { silent: true });
        savedTimezone = timezone;
      }
      celebrateStep();
      wizard.complete('identity');
    } catch (err: any) {
      toast.error(err?.message || "La langue n'a pas pu être enregistrée.");
    } finally {
      onboardingData.busy = false;
    }
  }
</script>

<WizardShell
  title="Dans quelle langue Kotbo doit-il parler ?"
  lead="Elle vaut pour tout ce que le bot écrit : ses réponses, ses panneaux, et le nom des salons qu'il va poser."
  {onEditTracks}
>
  <div class="grid gap-3 sm:grid-cols-2">
    {#each OPTIONS as option (option.key)}
      <button
        type="button"
        onclick={() => { language = option.key; celebrateStep(); }}
        aria-pressed={language === option.key}
        class="text-left rounded-2xl border p-4 transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40
        {language === option.key
          ? 'border-primary bg-primary/[0.05] shadow-sm shadow-primary/10'
          : 'border-outline-variant/40 hover:border-primary/45 hover:bg-surface-container-low/50'}"
      >
        <div class="flex items-center gap-2.5">
          <span class="text-xl leading-none">{option.flag}</span>
          <span class="text-[15px] font-semibold text-on-surface">{option.label}</span>
          {#if language === option.key}
            <span class="ml-auto w-4 h-4 rounded-full bg-primary text-on-primary flex items-center justify-center">
              <Papicon icon="check" size={10} />
            </span>
          {/if}
        </div>
      </button>
    {/each}
  </div>

  <div class="mt-6">
    <label for="timezone" class="flex items-center gap-2 text-[13px] font-semibold text-on-surface mb-2">
      <Papicon icon="clock" size={14} class="text-primary" />
      Fuseau horaire
    </label>
    <div class="flex items-center gap-3">
      <select
        id="timezone"
        bind:value={timezone}
        class="flex-1 min-w-0 rounded-xl border border-outline-variant/40 bg-surface-container-low/40 px-4 py-2.5 text-[14px] text-on-surface focus:outline-none focus:border-primary/50"
      >
        {#each COMMON_TIMEZONES as zone (zone.value)}
          <option value={zone.value}>{zone.label}</option>
        {/each}
        <!-- Un fuseau deja regle et absent de la liste courte resterait
             invisible dans le menu, et le simple fait d'ouvrir cet ecran le
             remplacerait par Paris. -->
        {#if !COMMON_TIMEZONES.some((zone) => zone.value === timezone)}
          <option value={timezone}>{timezone}</option>
        {/if}
      </select>
      {#if localTime}
        <span class="shrink-0 text-[13px] font-medium text-on-surface-variant/60 tabular-nums">
          il est {localTime}
        </span>
      {/if}
    </div>
    <p class="mt-2 text-[12px] text-on-surface-variant/55 leading-relaxed">
      Il décide de l'heure des rapports, des concours programmés et des statistiques quotidiennes.
    </p>
  </div>

  {#snippet preview()}
    <!-- Une barre de salons, pas un message : ce que la langue change ici, ce
         sont des noms, et c'est la qu'on les lit sur Discord. -->
    <div class="rounded-xl overflow-hidden border border-black/25 shadow-sm bg-[#2b2d31]">
      <div class="px-3.5 py-2.5 border-b border-black/25">
        <p class="text-[12px] font-semibold uppercase tracking-wide text-[#949ba4]">
          {language === 'fr' ? 'Accueil' : 'Welcome'}
        </p>
      </div>
      <div class="px-2 py-2 space-y-0.5">
        {#each samples as sample (sample)}
          <p class="flex items-center gap-1.5 rounded px-2 py-1 text-[13.5px] text-[#dbdee1]">
            <span class="text-[#80848e] text-[15px] leading-none">#</span>
            {sample.replace('#', '')}
          </p>
        {/each}
      </div>
    </div>

    <p class="mt-3 flex items-start gap-2 text-[12.5px] text-on-surface-variant/55 leading-relaxed">
      <Papicon icon="info" size={13} class="mt-0.5 shrink-0 text-on-surface-variant/35" />
      <span>{m.onb_shell_preview_hint()} lors de la mise en place.</span>
    </p>
  {/snippet}

  {#snippet footer()}
    <button
      type="button"
      onclick={apply}
      disabled={onboardingData.busy}
      class="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-on-primary text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-40"
    >
      {onboardingData.busy ? 'Enregistrement…' : 'Continuer'}
      <Papicon icon="ChevronRight" size={15} />
    </button>
  {/snippet}
</WizardShell>
