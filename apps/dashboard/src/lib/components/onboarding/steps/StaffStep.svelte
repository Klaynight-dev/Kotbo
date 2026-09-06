<script lang="ts">
  /**
   * Qui modere, et ou Kotbo doit s'adresser a eux.
   *
   * Sans cette reponse, un serveur configure de bout en bout reste muet le jour
   * ou quelque chose se passe : les sanctions s'appliquent, les raids sont
   * bloques, et personne n'en est prevenu. C'est aussi ce qui permet aux pages
   * d'equipe du tableau de bord d'exister - un rapport d'activite du staff n'a
   * rien a compter tant qu'on ne sait pas qui en fait partie.
   *
   * L'ecran a longtemps suppose que ces roles existaient deja. Sur un serveur
   * neuf ils n'existent pas, et « designez vos roles de moderation » devant une
   * liste vide n'est pas une question : c'est une impasse, dont on ne sortait
   * qu'en quittant le parcours pour aller batir une hierarchie sur Discord.
   *
   * D'ou les deux voies. Sur un serveur habite on coche ce qui est la, comme
   * avant. Sur un serveur neuf, Kotbo pose la hierarchie - dans l'un des deux
   * agencements qu'on retrouve partout, celui ou le proprietaire est Fondateur
   * et celui ou il est Administrateur - et l'on y ajoute les responsables de
   * pole dont on a l'usage. Le premier role retenu reste le role de reference,
   * quelle que soit la voie prise.
   */
  import { m } from '../../../i18n';
  import { toast } from '../../../stores/toast.svelte';
  import { wizard } from '../../../stores/onboardingWizard.svelte';
  import { onboardingData } from '../../../stores/onboardingData.svelte';
  import {
    STAFF_POLES,
    STAFF_STRUCTURES,
    buildStaffLadder,
    celebrateStep,
    defaultPoleKeys,
    toRoleRequests,
    type StaffStructureKey,
  } from '../../../onboarding';
  import { createOnboardingRoles, updateGlobalSettings } from '../../../api';
  import ChannelPicker from '../ChannelPicker.svelte';
  import ChoiceCard from '../ChoiceCard.svelte';
  import ToggleCard from '../ToggleCard.svelte';
  import Papicon from '../../Papicon.svelte';
  import WizardShell from '../WizardShell.svelte';

  const { onEditTracks, skip }: { onEditTracks: () => void; skip: () => void } = $props();

  const roles = $derived(onboardingData.roles);
  const channels = $derived(onboardingData.channels);

  /**
   * Ce qui est coche a l'ouverture.
   *
   * Les roles dont le nom parle de moderation sont proposes : sur un serveur
   * habite, ce sont presque toujours les bons, et confirmer coute infiniment
   * moins cher que parcourir trente roles.
   */
  const suggested = $derived(
    roles
      .filter((role) => /mod|admin|staff|resp|helper|support/i.test(role.name))
      .slice(0, 4)
      .map((role) => role.id)
  );
  const selection = $derived(wizard.staffRoleIds ?? suggested);

  const suggestedAlert = $derived(
    channels.find((channel) => /alert|staff|mod|log/i.test(channel.name))?.id ?? ''
  );
  const alertChannelId = $derived(wizard.staffAlertChannelId ?? suggestedAlert);

  // ── Voie prise ─────────────────────────────────────────────────────────────

  /**
   * A defaut de choix explicite, celle que l'etat du serveur impose.
   *
   * Un serveur sans le moindre role de moderation n'a rien a cocher : lui
   * ouvrir la liste vide serait le renvoyer sur Discord. A l'inverse, proposer
   * de creer une hierarchie a un serveur qui en a deja une, c'est proposer de
   * la doubler.
   */
  let chosenMode = $state<'existing' | 'create' | null>(null);
  const mode = $derived(
    chosenMode ?? (suggested.length > 0 || (wizard.staffRoleIds?.length ?? 0) > 0 ? 'existing' : 'create')
  );

  let structureKey = $state<StaffStructureKey>('founder');
  let poleKeys = $state<string[]>(defaultPoleKeys());

  const structure = $derived(
    STAFF_STRUCTURES.find((entry) => entry.key === structureKey) ?? STAFF_STRUCTURES[0]
  );
  const ladder = $derived(buildStaffLadder(structure, poleKeys));

  function toggle(id: string) {
    wizard.answer({
      staffRoleIds: selection.includes(id)
        ? selection.filter((entry) => entry !== id)
        : [...selection, id],
    });
    celebrateStep();
  }

  function togglePole(key: string) {
    poleKeys = poleKeys.includes(key)
      ? poleKeys.filter((entry) => entry !== key)
      : [...poleKeys, key];
    celebrateStep();
  }

  /**
   * Pose la hierarchie, puis bascule sur la voie « roles existants ».
   *
   * La bascule n'est pas cosmetique : les roles viennent d'etre crees, ils
   * existent donc, et l'ecran doit les montrer coches comme n'importe quels
   * autres. C'est aussi ce qui permet d'en decocher un avant de valider - un
   * « Responsable partenariats » cree puis juge inutile n'a pas a etre compte
   * dans les rapports d'equipe.
   */
  async function createLadder() {
    if (onboardingData.busy) return;
    onboardingData.busy = true;
    try {
      const result = await createOnboardingRoles(toRoleRequests(ladder));
      for (const warning of result.warnings) toast.info(warning);

      // Sans relecture, les roles crees n'existeraient pas dans la liste et la
      // selection pointerait sur des identifiants que l'ecran ne sait pas
      // afficher.
      await onboardingData.loadGuild(true);
      wizard.answer({ staffRoleIds: result.roles.map((entry) => entry.id) });
      chosenMode = 'existing';

      const created = result.roles.filter((entry) => entry.created).length;
      toast.success(m.onb_staff_created({ count: created }));
      celebrateStep();
    } catch (err: any) {
      toast.error(err?.message || "Les rôles n'ont pas pu être créés.");
    } finally {
      onboardingData.busy = false;
    }
  }

  async function apply() {
    if (onboardingData.busy) return;
    onboardingData.busy = true;
    try {
      await updateGlobalSettings({
        // Le premier retenu fait reference : c'est celui auquel les permissions
        // par defaut se rattachent. L'ordre affiche est celui de la hierarchie
        // Discord, donc le plus haut role coche l'emporte - ce qui est bien ce
        // qu'on veut.
        moderatorRoleId: selection[0] ?? null,
        baseStaffRoleId: selection[0] ?? null,
        sanctionAlertChannelId: alertChannelId || null,
      });
      wizard.answer({ staffRoleIds: selection, staffAlertChannelId: alertChannelId || null });
      celebrateStep();
      wizard.complete('staff');
    } catch (err: any) {
      toast.error(err?.message || "L'équipe n'a pas pu être enregistrée.");
    } finally {
      onboardingData.busy = false;
    }
  }
</script>

<WizardShell
  title={m.onb_staff_title()}
  lead={m.onb_staff_lead()}
  {onEditTracks}
>
  <div class="space-y-7">
    <div>
      <p class="text-[13px] font-semibold text-on-surface mb-2.5">{m.onb_staff_mode_label()}</p>
      <div class="grid gap-2.5 sm:grid-cols-2">
        <ChoiceCard
          label={m.onb_staff_mode_create()}
          pitch={m.onb_staff_mode_create_hint()}
          icon="sparkles"
          selected={mode === 'create'}
          onclick={() => { chosenMode = 'create'; }}
        />
        <ChoiceCard
          label={m.onb_staff_mode_existing()}
          pitch={m.onb_staff_mode_existing_hint()}
          icon="users"
          selected={mode === 'existing'}
          onclick={() => { chosenMode = 'existing'; }}
        />
      </div>
    </div>

    {#if mode === 'create'}
      <div>
        <p class="text-[13px] font-semibold text-on-surface mb-2.5">{m.onb_staff_structure_label()}</p>
        <div class="space-y-2.5">
          {#each STAFF_STRUCTURES as entry (entry.key)}
            <ChoiceCard
              label={entry.label}
              pitch={entry.pitch}
              detail={entry.detail}
              icon={entry.icon}
              selected={structureKey === entry.key}
              onclick={() => { structureKey = entry.key; celebrateStep(); }}
            />
          {/each}
        </div>
      </div>

      <div>
        <p class="text-[13px] font-semibold text-on-surface mb-1">{m.onb_staff_poles_label()}</p>
        <p class="text-[12.5px] text-on-surface-variant/60 leading-relaxed mb-3">
          {m.onb_staff_poles_hint()}
        </p>
        <div class="grid gap-2.5 sm:grid-cols-2">
          {#each STAFF_POLES as pole (pole.key)}
            <ToggleCard
              label={pole.name}
              detail={pole.duty}
              selected={poleKeys.includes(pole.key)}
              onclick={() => togglePole(pole.key)}
            >
              <span
                class="mt-1.5 inline-block w-8 h-1.5 rounded-full"
                style="background-color: {pole.color}"
              ></span>
            </ToggleCard>
          {/each}
        </div>
      </div>

      <button
        type="button"
        onclick={createLadder}
        disabled={onboardingData.busy}
        class="inline-flex items-center gap-2 rounded-xl border border-primary/40 bg-primary/[0.06] px-4 py-2.5
               text-[13.5px] font-semibold text-primary transition hover:bg-primary/[0.11]
               disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <Papicon
          icon={onboardingData.busy ? 'loader' : 'plus'}
          size={15}
          class={onboardingData.busy ? 'animate-spin' : ''}
        />
        {onboardingData.busy ? 'Création…' : m.onb_staff_create_action({ count: ladder.length })}
      </button>
    {:else}
      <div>
        <p class="text-[13px] font-semibold text-on-surface mb-2.5">{m.onb_staff_pick()}</p>

        {#if roles.length === 0}
          <p class="rounded-2xl border border-dashed border-outline-variant/40 px-4 py-6 text-center text-[13px] text-on-surface-variant/55 leading-relaxed">
            {m.onb_staff_empty()}
          </p>
        {:else}
          <div class="grid gap-2.5 sm:grid-cols-2 max-h-[380px] overflow-y-auto pr-1">
            {#each roles as role (role.id)}
              <ToggleCard
                label={role.name}
                selected={selection.includes(role.id)}
                onclick={() => toggle(role.id)}
              >
                <span
                  class="mt-1.5 inline-block w-8 h-1.5 rounded-full"
                  style="background-color: {role.color && role.color !== '#000000' ? role.color : 'var(--outline-variant, #64748b)'}"
                ></span>
              </ToggleCard>
            {/each}
          </div>
          <p class="mt-2 text-[12px] text-on-surface-variant/45 tabular-nums">
            {m.onb_staff_selected({ count: selection.length })}
          </p>
        {/if}
      </div>
    {/if}

    <ChannelPicker
      id="staff-alert"
      label={m.onb_staff_alert_label()}
      hint={m.onb_staff_alert_hint()}
      purpose="staffAlerts"
      value={alertChannelId}
      noneLabel={m.onb_logs_channel_none()}
      createLabel={m.onb_channel_create_alerts()}
      suggested={!wizard.staffAlertChannelId && !!suggestedAlert}
      onpick={(id) => wizard.answer({ staffAlertChannelId: id })}
    />
  </div>

  {#snippet preview()}
    <!-- Pas un faux salon Discord : ce que cet ecran rend possible, ce sont les
         pages d'equipe du tableau de bord, et c'est cela qu'on montre. Sauf
         pendant qu'on compose une hierarchie, ou c'est elle qu'il faut voir -
         une structure de six roles ne se juge pas sur son nombre. -->
    {#if mode === 'create'}
      <div class="rounded-2xl border border-outline-variant/30 bg-surface-container-lowest/50 p-4">
        <p class="text-[12.5px] font-semibold text-on-surface mb-3">{m.onb_staff_ladder_title()}</p>

        <div class="space-y-2">
          {#each ladder as role, index (role.key)}
            <div class="flex items-start gap-2.5" style="padding-left: {Math.min(index, 4) * 8}px">
              <span
                class="mt-1.5 w-2 h-2 rounded-full shrink-0"
                style="background-color: {role.color}"
              ></span>
              <div class="min-w-0 flex-1">
                <p class="text-[13px] font-medium text-on-surface truncate">{role.name}</p>
                <p class="text-[11.5px] text-on-surface-variant/50 leading-snug">{role.duty}</p>
              </div>
            </div>
          {/each}
        </div>

        <p class="mt-4 pt-3 border-t border-outline-variant/20 text-[12px] text-on-surface-variant/50 leading-relaxed">
          {m.onb_staff_ladder_hint()}
        </p>
      </div>
    {:else}
      <div class="rounded-2xl border border-outline-variant/30 bg-surface-container-lowest/50 p-4">
        <p class="text-[12.5px] font-semibold text-on-surface mb-3">{m.onb_staff_preview_title()}</p>

        <div class="space-y-2">
          {#each roles.filter((role) => selection.includes(role.id)).slice(0, 8) as role (role.id)}
            <div class="flex items-center gap-2.5">
              <span
                class="w-2 h-2 rounded-full shrink-0"
                style="background-color: {role.color && role.color !== '#000000' ? role.color : '#64748b'}"
              ></span>
              <span class="text-[13px] text-on-surface-variant/80 flex-1 min-w-0 truncate">{role.name}</span>
              <span class="text-[11px] tabular-nums text-on-surface-variant/35"></span>
            </div>
          {:else}
            <p class="text-[12.5px] text-on-surface-variant/40 py-3">Aucun rôle retenu pour l'instant.</p>
          {/each}
        </div>

        <p class="mt-4 pt-3 border-t border-outline-variant/20 text-[12px] text-on-surface-variant/50 leading-relaxed">
          {m.onb_staff_preview_hint()}
        </p>
      </div>
    {/if}
  {/snippet}

  {#snippet footer()}
    <button
      type="button"
      onclick={skip}
      class="text-[13px] font-medium text-on-surface-variant/50 hover:text-on-surface transition-colors"
    >
      Passer
    </button>
    <button
      type="button"
      onclick={apply}
      disabled={onboardingData.busy}
      class="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-[14px] font-semibold text-on-primary
             hover:brightness-110 transition disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      {onboardingData.busy ? 'Enregistrement…' : 'Continuer'}
      <Papicon icon="ChevronRight" size={15} />
    </button>
  {/snippet}
</WizardShell>
