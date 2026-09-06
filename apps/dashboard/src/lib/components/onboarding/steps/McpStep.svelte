<script lang="ts">
  /**
   * Le pilotage du serveur en langage naturel.
   *
   * C'est ce que Kotbo fait et que les autres bots ne font pas, et c'etait
   * enterre dans une page du tableau de bord qu'on ne trouve qu'en cherchant.
   * Le mettre dans le parcours, c'est faire en sorte que la chose la plus
   * surprenante du produit soit vue le premier jour plutot que le trentieme -
   * a supposer qu'on soit reste jusque-la.
   *
   * L'ecran cree une vraie cle et affiche une vraie adresse. Ce n'est pas une
   * demonstration : on repart avec de quoi brancher son client, tout de suite.
   *
   * Le perimetre se choisit avant, et la lecture seule est ce qui est propose.
   * Une cle donne un acces reel : une IA qui se trompe avec un droit de
   * sanction bannit quelqu'un, et la difference entre « elle regarde » et
   * « elle agit » doit etre un choix explicite, pas un defaut qu'on subit.
   */
  import { m } from '../../../i18n';
  import { toast } from '../../../stores/toast.svelte';
  import { authStore } from '../../../stores/auth.svelte';
  import { wizard } from '../../../stores/onboardingWizard.svelte';
  import { onboardingData } from '../../../stores/onboardingData.svelte';
  import { MCP_SCOPES, celebrateStep, celebratePhase, type McpScope } from '../../../onboarding';
  import { createMcpKey, fetchMcpDirectUrl } from '../../../api';
  import ChoiceCard from '../ChoiceCard.svelte';
  import Papicon from '../../Papicon.svelte';
  import WizardShell from '../WizardShell.svelte';

  const { onEditTracks, skip }: { onEditTracks: () => void; skip: () => void } = $props();

  const scope = $derived<McpScope>(wizard.mcpScope ?? 'read');
  const selectedGuild = $derived(
    authStore.guilds.find((guild) => guild.id === authStore.selectedGuildId)
  );

  /**
   * La cle creee, et ce qu'on en montre.
   *
   * `fullKey` n'est renvoye qu'a la creation : le serveur n'en garde qu'une
   * empreinte. Quitter l'ecran sans l'avoir copiee oblige a en creer une autre
   * depuis la page MCP, et l'ecran le dit avant plutot qu'apres.
   */
  let created = $state<{ id: string; fullKey: string } | null>(null);
  let directUrl = $state('');
  let copied = $state<'key' | 'url' | null>(null);

  async function createKey() {
    if (onboardingData.busy) return;
    onboardingData.busy = true;
    try {
      const permissions = MCP_SCOPES.find((entry) => entry.key === scope)?.permissions ?? [];
      const key = await createMcpKey({
        name: `Kotbo · ${selectedGuild?.name ?? 'serveur'}`,
        permissions,
      });
      if (!key?.id) throw new Error("La clé n'a pas pu être créée.");

      created = { id: key.id, fullKey: key.fullKey ?? '' };

      // L'adresse directe porte un jeton a duree de vie limitee : elle se
      // redemande, elle ne se devine pas. Son echec ne perd pas la cle - le
      // client peut aussi s'authentifier avec la cle seule.
      const url = await fetchMcpDirectUrl(key.id).catch(() => null);
      directUrl = url?.directUrl ?? '';

      wizard.answer({ mcpScope: scope });
      celebratePhase();
    } catch (err: any) {
      toast.error(err?.message || "La clé n'a pas pu être créée.");
    } finally {
      onboardingData.busy = false;
    }
  }

  async function copy(value: string, what: 'key' | 'url') {
    try {
      await navigator.clipboard.writeText(value);
      copied = what;
      celebrateStep();
      setTimeout(() => { copied = null; }, 1800);
    } catch {
      // Presse-papiers refuse - contexte non securise, permission bloquee : le
      // champ reste selectionnable a la main, ce qui est la seule alternative.
      toast.info('Copie impossible : sélectionnez le texte pour le copier.');
    }
  }
</script>

<WizardShell
  title={m.onb_mcp_title()}
  lead={m.onb_mcp_lead()}
  {onEditTracks}
>
  {#if !created}
    <div>
      <p class="text-[13px] font-semibold text-on-surface mb-2.5">{m.onb_mcp_scope_label()}</p>
      <div class="space-y-2.5">
        {#each MCP_SCOPES as entry (entry.key)}
          <ChoiceCard
            label={entry.label()}
            pitch={entry.pitch()}
            detail={entry.detail()}
            icon={entry.icon}
            badge={entry.key === 'read' ? 'Recommandé' : undefined}
            selected={scope === entry.key}
            onclick={() => { wizard.answer({ mcpScope: entry.key }); celebrateStep(); }}
          />
        {/each}
      </div>
    </div>
  {:else}
    <div class="space-y-5">
      <div class="rounded-2xl border border-primary/30 bg-primary/[0.04] p-4">
        <p class="flex items-center gap-2 text-[13.5px] font-semibold text-on-surface">
          <Papicon icon="check-circle" size={15} class="text-emerald-500" />
          {m.onb_mcp_key_ready()}
        </p>

        <div class="mt-3 flex items-center gap-2">
          <code class="flex-1 min-w-0 truncate rounded-lg bg-surface-container-lowest/70 px-3 py-2 text-[12.5px] font-mono text-on-surface">
            {created.fullKey}
          </code>
          <button
            type="button"
            onclick={() => copy(created!.fullKey, 'key')}
            class="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-outline-variant/40 px-3 py-2
                   text-[12.5px] font-medium text-on-surface-variant/80 hover:border-primary/45 hover:text-on-surface transition-colors"
          >
            <Papicon icon={copied === 'key' ? 'check' : 'copy'} size={12} />
            {copied === 'key' ? m.onb_mcp_copied() : m.onb_mcp_copy()}
          </button>
        </div>

        <p class="mt-2.5 text-[12.5px] text-amber-500/90 leading-relaxed">
          {m.onb_mcp_key_warning()}
        </p>
      </div>

      {#if directUrl}
        <div>
          <p class="text-[13px] font-semibold text-on-surface mb-1.5">{m.onb_mcp_url_label()}</p>
          <div class="flex items-center gap-2">
            <code class="flex-1 min-w-0 truncate rounded-lg border border-outline-variant/40 bg-surface-container-lowest/60 px-3 py-2 text-[12.5px] font-mono text-on-surface-variant/85">
              {directUrl}
            </code>
            <button
              type="button"
              onclick={() => copy(directUrl, 'url')}
              class="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-outline-variant/40 px-3 py-2
                     text-[12.5px] font-medium text-on-surface-variant/80 hover:border-primary/45 hover:text-on-surface transition-colors"
            >
              <Papicon icon={copied === 'url' ? 'check' : 'copy'} size={12} />
              {copied === 'url' ? m.onb_mcp_copied() : m.onb_mcp_copy()}
            </button>
          </div>
        </div>
      {/if}

      <div>
        <p class="text-[13px] font-semibold text-on-surface mb-2">{m.onb_mcp_try()}</p>
        <ul class="space-y-1.5">
          {#each [m.onb_mcp_example_1(), m.onb_mcp_example_2(), m.onb_mcp_example_3()] as example (example)}
            <li class="flex items-start gap-2 text-[13px] text-on-surface-variant/70">
              <Papicon icon="message-circle" size={12} class="mt-1 shrink-0 text-primary/60" />
              <span>« {example} »</span>
            </li>
          {/each}
        </ul>
      </div>
    </div>
  {/if}

  {#snippet preview()}
    <!-- Une conversation, pas un salon Discord : c'est bien la que le MCP se
         vit, et montrer un embed ici raconterait autre chose. -->
    <div class="rounded-2xl border border-outline-variant/30 bg-surface-container-lowest/50 overflow-hidden">
      <div class="flex items-center gap-2 px-4 py-2.5 border-b border-outline-variant/20">
        <Papicon icon="command" size={13} class="text-primary" />
        <span class="text-[12.5px] font-semibold text-on-surface">Kotbo MCP</span>
      </div>

      <div class="p-4 space-y-3">
        <div class="flex justify-end">
          <p class="max-w-[85%] rounded-2xl rounded-br-sm bg-primary/12 px-3.5 py-2 text-[13px] text-on-surface">
            {m.onb_mcp_example_1()}
          </p>
        </div>

        <div class="flex justify-start">
          <p class="max-w-[92%] rounded-2xl rounded-bl-sm bg-surface-container/70 px-3.5 py-2 text-[13px] leading-relaxed text-on-surface-variant/85">
            {m.onb_mcp_preview_answer()}
          </p>
        </div>
      </div>
    </div>
  {/snippet}

  {#snippet footer()}
    {#if !created}
      <button
        type="button"
        onclick={skip}
        class="text-[13px] font-medium text-on-surface-variant/50 hover:text-on-surface transition-colors"
      >
        Passer
      </button>
      <button
        type="button"
        onclick={createKey}
        disabled={onboardingData.busy}
        class="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-[14px] font-semibold text-on-primary
               hover:brightness-110 transition disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        {onboardingData.busy ? m.onb_mcp_creating() : m.onb_mcp_create()}
        <Papicon icon="key" size={15} />
      </button>
    {:else}
      <button
        type="button"
        onclick={() => wizard.complete('mcp')}
        class="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-[14px] font-semibold text-on-primary
               hover:brightness-110 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        Continuer
        <Papicon icon="ChevronRight" size={15} />
      </button>
    {/if}
  {/snippet}
</WizardShell>
