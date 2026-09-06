<script lang="ts">
  /**
   * Section « Configuration rapide » de l'economie.
   *
   * Un rythme regle d'un coup les gains du daily, son delai et l'energie. Il ne releve
   * d'aucun onglet de la page Economie : il vivait en tete de celle-ci, derriere un
   * basculement entre deux vues qui obligeait a repasser par la configuration detaillee
   * pour retrouver le reste. Sa propre entree de menu en fait le chemin le plus court
   * pour qui veut demarrer sans rien regler en detail, exactement comme les niveaux de
   * protection cote securite.
   *
   * Le composant charge et enregistre lui-meme la configuration : la page qui l'accueille
   * n'a aucune raison de porter cet etat.
   */
  import { router } from 'tinro';
  import { onMount, onDestroy, untrack } from 'svelte';
  import { m } from '../../i18n';
  import { dashboardStore } from '../../stores/dashboard.svelte';
  import { unsavedChanges } from '../../stores/unsavedChanges.svelte';
  import { createAsyncActionState } from '../../asyncAction.svelte';
  import Skeleton from '../Skeleton.svelte';
  import InlineFeedback from '../InlineFeedback.svelte';
  import EconomyPresetPicker from '../EconomyPresetPicker.svelte';
  import { findEconomyPreset, type EconomyPreset, type EconomyPresetValues } from '../../economyPresets';
  import { fetchEconomyConfig, updateEconomyConfig } from '../../api';

  const actionState = createAsyncActionState();
  let loading = $state(true);
  // Sans cet etat, un chargement en echec rendait une page blanche : ni rythme, ni
  // explication, alors que la cause est presque toujours une configuration illisible.
  let loadFailed = $state(false);

  const canManageSettings = $derived(
    !!dashboardStore.state.featureAccess?.economy?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
  );

  // La configuration est chargee telle quelle et renvoyee entiere : un rythme ne touche
  // qu'a six champs, tout le reste doit repartir intact.
  type Config = Partial<EconomyPresetValues> & Record<string, unknown>;

  let config = $state<Config | null>(null);
  let savedConfig = $state<Config | null>(null);

  const dirty = $derived(JSON.stringify(config) !== JSON.stringify(savedConfig));
  const selectedPreset = $derived(config ? findEconomyPreset(config) : null);
  const activePreset = $derived(savedConfig ? findEconomyPreset(savedConfig) : null);

  function valuesOf(source: Config): EconomyPresetValues {
    return {
      dailyRewardMin: Number(source.dailyRewardMin) || 0,
      dailyRewardMax: Number(source.dailyRewardMax) || 0,
      dailyCooldownHour: Number(source.dailyCooldownHour) || 0,
      adventureCooldownMin: Number(source.adventureCooldownMin) || 0,
      maxEnergy: Number(source.maxEnergy) || 0,
      energyRecoveryPerHour: Number(source.energyRecoveryPerHour) || 0,
    };
  }

  // Des qu'un rythme est choisi, la configuration courante est la sienne : la carte
  // « Personnalise » doit alors montrer la configuration enregistree, sans quoi elle
  // devient le sosie de la carte qu'on vient de cliquer.
  const customValues = $derived(valuesOf((selectedPreset ? savedConfig : config) ?? {}));

  const OWNER = 'economy-quick-setup';

  $effect(() => {
    if (dirty && canManageSettings) {
      untrack(() => {
        unsavedChanges.register({
          id: OWNER,
          label: m.eco_quick_setup_title(),
          onSave: () => save(),
          onReset: () => {
            config = savedConfig ? JSON.parse(JSON.stringify(savedConfig)) : null;
          },
        });
      });
    } else {
      untrack(() => {
        unsavedChanges.release(OWNER);
      });
    }
  });

  onDestroy(() => {
    unsavedChanges.release(OWNER);
  });

  onMount(async () => {
    try {
      // Les droits viennent du store, que ModulePage ne rafraichit qu'au bascul d'un
      // module : sans cet appel, la section peut s'afficher en lecture seule alors que
      // l'administrateur peut tout regler.
      const [, res] = await Promise.all([dashboardStore.refresh(), fetchEconomyConfig()]);
      if (res?.config) {
        config = res.config;
        savedConfig = JSON.parse(JSON.stringify(res.config));
      } else {
        loadFailed = true;
      }
    } catch (err) {
      console.error(err);
      loadFailed = true;
    } finally {
      loading = false;
    }
  });

  function selectPreset(preset: EconomyPreset) {
    if (!canManageSettings || !config) return;
    Object.assign(config, preset.values);
  }

  /**
   * Un rythme n'ecrit que ses six champs.
   *
   * Renvoyer la configuration entiere ferait dependre l'enregistrement d'un rythme de la
   * validite de tout le reste : un raid allume sans salon d'annonce, par exemple, ferait
   * echouer cette page qui n'a rien a voir avec lui et depuis laquelle on ne peut rien y
   * faire. La route ignore les champs absents.
   */
  async function save(): Promise<boolean> {
    if (!canManageSettings || !config) return false;

    let success = false;
    await actionState.run(async () => {
      const res = await updateEconomyConfig(valuesOf(config));
      if (!res?.config) throw new Error(m.eco_quick_setup_save_failed());
      config = res.config;
      savedConfig = JSON.parse(JSON.stringify(res.config));
      success = true;
      return true;
    }, { successMessage: m.eco_toast_config_saved() });
    return success;
  }
</script>

<InlineFeedback state={actionState} />

{#if loading}
  <Skeleton height="350px" radius="2.5rem" />
{:else if loadFailed || !config}
  <p class="text-sm text-on-surface-variant/70 bg-surface-container-high/30 border border-outline-variant/10 rounded-xl px-6 py-8 text-center leading-relaxed">
    {m.eco_config_load_failed()}
  </p>
{:else}
  <EconomyPresetPicker
    selectedId={selectedPreset?.id ?? null}
    activeId={activePreset?.id ?? null}
    {customValues}
    currencyName={String(config.currencyName ?? '')}
    disabled={!canManageSettings}
    {dirty}
    saving={actionState.state.loading}
    moduleEnabled={config.enabled === true}
    onselect={selectPreset}
    onsave={save}
    ondetail={() => router.goto('/economy')}
  />
{/if}
