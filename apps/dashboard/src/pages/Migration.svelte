<script lang="ts">
  /**
   * Reprise : ce que Kotbo peut recuperer d'un serveur deja equipe.
   *
   * Trois blocs, dans l'ordre ou on se pose les questions : quels bots sont la,
   * qu'a-t-on trouve sur le serveur, et que restera-t-il a refaire a la main.
   * Rien n'est ecrit sans que le staff n'ait coche la proposition.
   */
  import { onMount } from 'svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import {
    fetchMigrationPlan,
    applyMigrationPlan,
    inspectMigrationExport,
    assignMigrationValues,
  } from '../lib/api';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import SectionCard from '../lib/components/SectionCard.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import ActionButton from '../lib/components/ActionButton.svelte';
  import LoadingHint from '../lib/components/LoadingHint.svelte';
  import FormSelect from '../lib/components/FormSelect.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import RecoveredContent from '../lib/components/onboarding/RecoveredContent.svelte';
  // Les memes formes qu'a l'onboarding, et non une copie : les deux surfaces
  // lisent la meme route, et une copie finit par en decrire une version morte.
  import type { MigrationPlan as Plan } from '../lib/stores/onboardingData.svelte';

  let plan = $state<Plan | null>(null);
  let loading = $state(true);
  let applying = $state(false);
  let selected = $state<Record<string, boolean>>({});

  // Import d'un export tiers.
  let candidates = $state<{ path: string; value: string; kind: string; name: string }[]>([]);
  let assignments = $state<Record<string, string>>({});
  let inspecting = $state(false);
  let settings = $state<string[]>([]);

  const SETTING_LABELS: Record<string, string> = {
    ticketCategory: 'Catégorie des tickets',
    ticketLogChannel: 'Salon de logs des tickets',
    welcomeChannel: "Salon d'accueil",
    logChannel: 'Salon de logs',
    suggestionChannel: 'Salon de résumé',
    moderatorRole: 'Rôle modérateur',
  };

  const FEATURE_LABELS: Record<string, string> = {
    tickets: 'Tickets',
    welcome: 'Bienvenue',
    reactionRoles: 'Rôles par réaction',
    automod: 'AutoMod',
    leveling: 'Niveaux',
    stats: 'Statistiques',
    logs: 'Logs',
    rules: 'Règlement',
  };

  /** Les seules propositions applicables : celles qui portent une action. */
  const actionable = $derived((plan?.findings ?? []).filter((f) => f.action));
  const selectedCount = $derived(Object.values(selected).filter(Boolean).length);

  /** Un salon cité dix fois dans l'export ne mérite pas dix lignes. */
  const uniqueCandidates = $derived(
    candidates.filter((c, i) => candidates.findIndex((o) => o.value === c.value) === i)
  );

  async function load() {
    if (!authStore.selectedGuildId) return;
    loading = true;
    try {
      plan = await fetchMigrationPlan();
      selected = {};
    } catch (err: any) {
      toast.error(err?.message || "L'analyse du serveur a échoué");
      plan = null;
    } finally {
      loading = false;
    }
  }

  async function applySelection() {
    const keys = Object.entries(selected).filter(([, on]) => on).map(([key]) => key);
    if (keys.length === 0 || applying) return;

    applying = true;
    try {
      const res = await applyMigrationPlan(keys);
      if (res?.plan) plan = res.plan;
      selected = {};

      const applied = res?.applied?.length ?? 0;
      const skipped = res?.skipped?.length ?? 0;
      if (skipped > 0) toast.warning(`${applied} réglage(s) repris, ${skipped} ignoré(s)`);
      else toast.success(`${applied} réglage(s) repris`);
    } catch (err: any) {
      toast.error(err?.message || 'La reprise a échoué');
    } finally {
      applying = false;
    }
  }

  async function handleFile(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;

    inspecting = true;
    try {
      const parsed = JSON.parse(await file.text());
      const res = await inspectMigrationExport(parsed);
      candidates = res?.candidates ?? [];
      settings = res?.settings ?? [];
      assignments = {};

      if (candidates.length === 0) {
        toast.info("Aucun identifiant de ce serveur n'a été trouvé dans le fichier.");
      }
    } catch (err: any) {
      toast.error(err instanceof SyntaxError ? "Ce fichier n'est pas un JSON valide" : (err?.message || 'Lecture impossible'));
    } finally {
      inspecting = false;
    }
  }

  async function saveAssignments() {
    const list = Object.entries(assignments)
      .filter(([, value]) => value)
      .map(([setting, value]) => ({ setting, value }));
    if (list.length === 0) return;

    try {
      await assignMigrationValues(list);
      toast.success(`${list.length} réglage(s) associé(s)`);
      assignments = {};
      await load();
    } catch (err: any) {
      toast.error(err?.message || "L'association a échoué");
    }
  }

  onMount(load);

  $effect(() => {
    const guildId = authStore.selectedGuildId;
    if (guildId) void load();
  });
</script>

<ModulePage
  title="Reprise"
  description="Ce que Kotbo peut récupérer d'un serveur déjà équipé par d'autres bots"
  icon="download"
  featureKey="settings"
>
  {#snippet actions()}
    <RefreshButton onclick={load} loading={loading} />
  {/snippet}

  {#if loading && !plan}
    <LoadingHint context="config" />
  {:else if !plan}
    <EmptyState icon="alert-triangle" title="Analyse indisponible" description="Relancez l'analyse du serveur." />
  {:else}
    <div class="space-y-4">
      <!-- ── Bots détectés ──────────────────────────────────────────────── -->
      <SectionCard
        title="Bots présents"
        description="Kotbo reconnaît les bots les plus répandus par leur nom, puis cherche sur le serveur la trace des fonctions qu'ils utilisent vraiment."
      >
        {#if plan.bots.length === 0}
          <p class="text-[13px] text-on-surface-variant">
            Aucun autre bot sur ce serveur. Rien à reprendre.
          </p>
        {:else}
          <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5">
            {#each plan.bots as bot (bot.id)}
              {@const activeFeatures = new Set(bot.activeFeatures.map((entry) => entry.feature))}
              <div class="rounded-xl border border-outline-variant/30 bg-surface-container-low/40 p-3">
                <div class="flex items-center gap-2.5">
                  {#if bot.avatarUrl}
                    <img
                      src={bot.avatarUrl}
                      alt=""
                      referrerpolicy="no-referrer"
                      class="w-7 h-7 rounded-lg object-cover shrink-0"
                    />
                  {:else}
                    <Papicon icon="robot" size={14} class={bot.label ? 'text-primary' : 'text-on-surface-variant/50'} />
                  {/if}
                  <div class="min-w-0">
                    <p class="text-[13px] font-medium text-on-surface truncate">{bot.label ?? bot.username}</p>
                    {#if bot.label && bot.label !== bot.username}
                      <p class="text-[11px] text-on-surface-variant/60 truncate">{bot.username}</p>
                    {/if}
                  </div>
                </div>

                {#if bot.covers.length > 0}
                  <!-- Une puce pleine : la trace de la fonction a été trouvée
                       sur le serveur. Une puce estompée : le bot sait le faire,
                       mais rien ne dit qu'il s'en sert ici. -->
                  <div class="mt-2 flex flex-wrap gap-1">
                    {#each bot.covers as feature}
                      <span
                        class="text-[10.5px] px-1.5 py-0.5 rounded {activeFeatures.has(feature)
                          ? 'bg-primary/10 text-primary'
                          : 'bg-surface-container text-on-surface-variant/60'}"
                      >
                        {FEATURE_LABELS[feature] ?? feature}
                      </span>
                    {/each}
                  </div>
                  {#if bot.activeFeatures.length > 0}
                    <ul class="mt-2 space-y-0.5">
                      {#each bot.activeFeatures as entry (entry.feature)}
                        <li class="text-[11px] text-on-surface-variant/70 leading-relaxed">
                          <span class="text-primary/80">{FEATURE_LABELS[entry.feature] ?? entry.feature}</span> · {entry.evidence}
                        </li>
                      {/each}
                    </ul>
                  {/if}
                {:else if bot.label}
                  <!-- Reconnu, mais rien de ce qu'il fait n'entre dans Kotbo :
                       un bot de bump ou de musique. Le dire, plutot que de
                       renvoyer le staff verifier a la main un bot dont il n'y
                       a rien a reprendre. -->
                  <p class="mt-1.5 text-[11.5px] text-on-surface-variant/60">
                    Rien à reprendre  Kotbo ne couvre pas ce que fait ce bot.
                  </p>
                {:else}
                  <p class="mt-1.5 text-[11.5px] text-on-surface-variant/60">Bot non reconnu  à vérifier à la main.</p>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </SectionCard>

      <!-- ── Ce qu'on a trouvé ──────────────────────────────────────────── -->
      <SectionCard
        title="Trouvé sur le serveur"
        description="Le nom d'un salon est un indice, pas une preuve : vérifiez avant d'appliquer."
      >
        {#snippet actions()}
          {#if actionable.length > 0}
            <ActionButton
              variant="primary"
              size="sm"
              icon="download"
              label={selectedCount > 0 ? `Reprendre (${selectedCount})` : 'Reprendre'}
              disabled={selectedCount === 0 || applying}
              onclick={applySelection}
            />
          {/if}
        {/snippet}

        {#if plan.findings.length === 0}
          <EmptyState
            icon="search"
            title="Rien de repérable"
            description="Aucun salon ni règle ne trahit une configuration existante. Tout est à configurer depuis les pages de Kotbo."
          />
        {:else}
          <div class="space-y-2">
            {#each plan.findings as finding (finding.key)}
              <div class="rounded-xl border border-outline-variant/30 bg-surface-container-low/40 p-4">
                <div class="flex items-start gap-3">
                  {#if finding.action}
                    <input
                      type="checkbox"
                      checked={selected[finding.key] ?? false}
                      onchange={(e) => (selected = { ...selected, [finding.key]: e.currentTarget.checked })}
                      class="w-4 h-4 mt-0.5 rounded text-primary focus:ring-primary border-outline-variant/30 shrink-0"
                    />
                  {:else}
                    <Papicon icon="info" size={15} class="text-sky-500 mt-0.5 shrink-0" />
                  {/if}

                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 flex-wrap">
                      <h4 class="text-[13.5px] font-semibold text-on-surface">{finding.title}</h4>
                      <span class="text-[10.5px] px-1.5 py-0.5 rounded bg-surface-container text-on-surface-variant">
                        {FEATURE_LABELS[finding.feature] ?? finding.feature}
                      </span>
                    </div>
                    <p class="mt-1 text-[12.5px] text-on-surface-variant leading-relaxed">{finding.detail}</p>

                    {#if finding.entities.length > 0}
                      <div class="mt-2 flex flex-wrap gap-1">
                        {#each finding.entities as entity (entity.id)}
                          <span class="text-[11px] px-1.5 py-0.5 rounded bg-surface-container text-on-surface-variant">
                            {entity.name}
                          </span>
                        {/each}
                      </div>
                    {/if}

                    {#if finding.payload}
                      <RecoveredContent payload={finding.payload} />
                    {/if}

                    {#if finding.action}
                      <p class="mt-2 text-[12px] text-primary/90 pl-2.5 border-l-2 border-primary/40">
                        {finding.action}
                      </p>
                    {:else}
                      <p class="mt-2 text-[11.5px] text-on-surface-variant/60 italic">
                        Constat informatif : rien à appliquer automatiquement.
                      </p>
                    {/if}
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </SectionCard>

      <!-- ── Import d'un export ─────────────────────────────────────────── -->
      <SectionCard
        title="Importer un export"
        description="Les bots n'exportent pas le même format. Kotbo ne devine donc rien : il relève les identifiants Discord du fichier et vous laissez chacun à sa place."
      >
        <input
          type="file"
          accept="application/json,.json"
          onchange={handleFile}
          disabled={inspecting}
          class="block w-full text-[13px] text-on-surface-variant
          file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border file:border-outline-variant/40
          file:bg-surface-container file:text-on-surface file:text-[12px] file:font-medium
          hover:file:border-outline-variant file:cursor-pointer"
        />

        {#if uniqueCandidates.length > 0}
          <div class="mt-4 space-y-2">
            {#each uniqueCandidates as candidate (candidate.value)}
              <div class="flex flex-col sm:flex-row sm:items-center gap-2 rounded-xl border border-outline-variant/30 bg-surface-container-low/40 px-3 py-2.5">
                <div class="min-w-0 flex-1">
                  <p class="text-[12.5px] font-medium text-on-surface truncate">
                    {candidate.kind === 'channel' ? '#' : '@'}{candidate.name}
                  </p>
                  <p class="text-[11px] text-on-surface-variant/60 font-mono truncate">{candidate.path}</p>
                </div>
                <FormSelect
                  value={assignments[candidate.value] ?? ''}
                  onchange={(e: Event) => {
                    assignments = { ...assignments, [candidate.value]: (e.target as HTMLSelectElement).value };
                  }}
                  className="w-full sm:w-56"
                >
                  <option value="">Ne pas utiliser</option>
                  {#each settings as setting}
                    <option value={setting}>{SETTING_LABELS[setting] ?? setting}</option>
                  {/each}
                </FormSelect>
              </div>
            {/each}

            <div class="flex justify-end pt-1">
              <ActionButton
                variant="primary"
                size="sm"
                label="Enregistrer les associations"
                disabled={Object.values(assignments).filter(Boolean).length === 0}
                onclick={saveAssignments}
              />
            </div>
          </div>
        {/if}
      </SectionCard>

      <!-- ── Ce qui reste à faire ───────────────────────────────────────── -->
      {#if plan.manualSteps.length > 0}
        <SectionCard
          title="À refaire à la main"
          description="Ces données vivent dans la base de l'ancien bot : aucune inspection du serveur ne les rend."
        >
          <ul class="space-y-2">
            {#each plan.manualSteps as step (step.feature)}
              <li class="flex items-start gap-2.5">
                <Papicon icon="alert-triangle" size={14} class="text-amber-500 mt-0.5 shrink-0" />
                <div>
                  <p class="text-[13px] font-medium text-on-surface">{step.label}</p>
                  <p class="text-[12px] text-on-surface-variant leading-relaxed">{step.why}</p>
                </div>
              </li>
            {/each}
          </ul>
        </SectionCard>
      {/if}
    </div>
  {/if}
</ModulePage>
