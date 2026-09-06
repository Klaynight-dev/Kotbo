<script lang="ts">
  /**
   * « Quel salon est quoi ? », section par section.
   *
   * Le seul ecran du parcours ou c'est le serveur qui parle et Kotbo qui
   * ecoute. Avant lui, la reprise procedait par ressemblance de noms : ce
   * qu'elle reconnaissait etait laisse tranquille, tout le reste etait recree.
   * Un `#logs-mod` de trois ans ne ressemblait pas assez a `#staff-logs`, donc
   * un second salon de journalisation se posait a cote - et l'administrateur le
   * decouvrait sur Discord, apres coup, avec ses moderateurs repartis entre les
   * deux.
   *
   * Trois issues par ligne, et aucune n'est prise a sa place : utiliser un
   * salon qui existe, en creer un, ne rien faire. La detection reste, retrogradee
   * au rang de suggestion pre-remplie - ce qui est la seule place qu'elle merite
   * tant qu'elle repose sur des noms. Ce que Kotbo a pose lui-meme est verrouille
   * : on ne redesigne pas un salon dont on tient l'identifiant.
   *
   * La categorie ouvre l'ecran plutot que de figurer en fin de liste, parce que
   * « ou est-ce que ca vit ? » se repond avant « qu'est-ce qui vit la ? ». Elle
   * n'offre pas « ne rien faire » : le bot rattache d'office la categorie d'un
   * salon retenu, un ecran qui pretendrait le contraire mentirait. Elle
   * s'efface d'elle-meme quand tous ses salons ont ete ecartes.
   */
  import { wizard } from '../../../stores/onboardingWizard.svelte';
  import { onboardingData } from '../../../stores/onboardingData.svelte';
  import {
    dormantModules,
    isSkippable,
    linesOf,
    mappingScreen,
    type MappingDecision,
    type ThemeKey,
  } from '../../../onboarding';
  import type { ServerTemplatePlanItem } from '../../../api';
  import Papicon from '../../Papicon.svelte';
  import WizardShell from '../WizardShell.svelte';

  const { onEditTracks }: { onEditTracks: () => void } = $props();

  const template = $derived(onboardingData.template);
  const theme = $derived<ThemeKey>(wizard.theme ?? 'communaute');
  const screen = $derived(mappingScreen(wizard.step));
  const mapping = $derived(wizard.mapping);
  const matches = $derived(template?.matches ?? {});

  const lines = $derived(
    template && screen ? linesOf(template.plan, screen, theme) : []
  );
  const category = $derived(lines.find((line) => line.kind === 'category') ?? null);
  const contents = $derived(lines.filter((line) => line.kind !== 'category'));

  const decisionOf = (key: string): MappingDecision =>
    mapping[key] ?? { mode: 'create', id: null };

  /**
   * Ce que Kotbo a pose lui-meme, dont on tient l'identifiant.
   *
   * Ces lignes ne se rejouent pas : redesigner un salon dont la trace existe
   * reviendrait a en abandonner un qui porte deja des messages, sans rien
   * gagner. Elles s'affichent rattachees et fermees.
   */
  const isLocked = (key: string): boolean => matches[key]?.source === 'ref';

  /** Ce que la detection propose sans l'avoir applique : la ligne le dit. */
  const isSuggested = (key: string): boolean => {
    const match = matches[key];
    return !!match && match.source === 'name' && decisionOf(key).id === match.id;
  };

  /**
   * Les candidats d'une ligne, dans la nature qui lui convient.
   *
   * Un salon vocal nomme « général » ne remplace pas le salon textuel du meme
   * nom, et une categorie encore moins : le bot le refuserait, autant ne pas le
   * proposer.
   */
  function candidatesFor(item: ServerTemplatePlanItem) {
    const inventory = template?.inventory;
    if (!inventory) return [] as { id: string; name: string; disabled: boolean; note: string | null }[];

    // Un meme salon ne peut pas tenir deux roles du plan : il recevrait deux
    // cablages contradictoires, et le second effacerait le premier.
    const takenBy = new Map<string, string>();
    for (const [key, decision] of Object.entries(mapping)) {
      if (key === item.key || decision.mode !== 'adopt' || !decision.id) continue;
      const other = template?.plan.find((entry) => entry.key === key);
      if (other) takenBy.set(decision.id, other.name);
    }

    if (item.kind === 'role') {
      return inventory.roles.map((role) => ({
        id: role.id,
        name: role.name,
        disabled: !role.assignable || takenBy.has(role.id),
        note: takenBy.get(role.id)
          ? `déjà utilisé pour ${takenBy.get(role.id)}`
          : role.managed
            ? 'géré par une intégration'
            : !role.assignable
              ? 'au-dessus du rôle de Kotbo'
              : null,
      }));
    }

    return inventory.channels
      .filter((channel) => channel.kind === item.kind)
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        disabled: takenBy.has(channel.id),
        note: takenBy.get(channel.id) ? `déjà utilisé pour ${takenBy.get(channel.id)}` : null,
      }));
  }

  /** L'etat du menu, encode en une valeur : c'est ce que le `select` porte. */
  const valueOf = (key: string): string => {
    const decision = decisionOf(key);
    return decision.mode === 'adopt' && decision.id ? `adopt:${decision.id}` : decision.mode;
  };

  function choose(item: ServerTemplatePlanItem, raw: string): void {
    if (raw.startsWith('adopt:')) {
      wizard.decide(item.key, { mode: 'adopt', id: raw.slice(6) });
    } else if (raw === 'skip') {
      wizard.decide(item.key, { mode: 'skip', id: null });
    } else {
      wizard.decide(item.key, { mode: 'create', id: null });
    }
    syncCategory();
  }

  /**
   * La categorie suit ses salons.
   *
   * Le bot rattache d'office la categorie de tout salon retenu : la laisser
   * cochee quand plus rien n'y va poserait une categorie vide, et la laisser
   * decochee quand un salon y va serait un ecran qui raconte autre chose que ce
   * qui se passe. On la deduit donc, on ne la demande pas.
   */
  function syncCategory(): void {
    if (!category) return;
    const anyKept = contents.some((line) => decisionOf(line.key).mode !== 'skip');
    const current = decisionOf(category.key);

    if (!anyKept && current.mode !== 'skip') {
      wizard.decide(category.key, { mode: 'skip', id: null });
    } else if (anyKept && current.mode === 'skip') {
      const match = matches[category.key];
      wizard.decide(category.key, match ? { mode: 'adopt', id: match.id } : { mode: 'create', id: null });
    }
  }

  /** Ou atterrira ce que cet ecran cree. */
  const destination = $derived.by(() => {
    if (!category) return 'à la racine du serveur';
    const decision = decisionOf(category.key);
    if (decision.mode === 'skip') return 'à la racine du serveur';
    if (decision.mode === 'adopt') {
      const found = template?.inventory.channels.find((channel) => channel.id === decision.id);
      return found ? `dans ${found.name}` : 'dans la catégorie choisie';
    }
    return `dans ${category.name}, que Kotbo créera`;
  });

  /** Les modules que les lignes ecartees de cet ecran laisseront eteints. */
  const dormant = $derived(
    template
      ? dormantModules(template.plan, mapping).filter((entry) =>
          contents.some((line) => line.name === entry.because),
        )
      : []
  );

  const tally = $derived({
    adopted: contents.filter((line) => decisionOf(line.key).mode === 'adopt').length,
    created: contents.filter((line) => decisionOf(line.key).mode === 'create').length,
    skipped: contents.filter((line) => decisionOf(line.key).mode === 'skip').length,
  });
</script>

<WizardShell
  title={screen?.title}
  lead={screen?.lead}
  {onEditTracks}
>
  <div class="space-y-5">
    <!-- ── La catégorie : où tout ça vit ─────────────────────────────────── -->
    {#if category}
      {@const locked = isLocked(category.key)}
      {@const skipped = decisionOf(category.key).mode === 'skip'}
      <div class="rounded-xl border border-outline-variant/30 bg-surface-container-low/40 px-4 py-3.5">
        <div class="flex items-center gap-2 mb-2">
          <Papicon icon="folder" size={13} class="text-primary/70" />
          <span class="text-[12.5px] font-semibold text-on-surface">La catégorie</span>
          {#if locked}
            <span class="text-[11px] font-medium text-primary/70 rounded-full bg-primary/10 px-2 py-0.5">
              posée par Kotbo
            </span>
          {/if}
        </div>

        {#if skipped}
          <p class="text-[13px] text-on-surface-variant/60 leading-relaxed">
            Aucun salon à y ranger : Kotbo ne créera pas de catégorie.
          </p>
        {:else}
          <select
            value={valueOf(category.key)}
            disabled={locked}
            onchange={(event) => choose(category, event.currentTarget.value)}
            class="w-full rounded-lg border border-outline-variant/40 bg-surface-container-lowest/60 px-3 py-2 text-[13.5px] text-on-surface disabled:opacity-50"
          >
            <optgroup label="Catégories du serveur">
              {#each candidatesFor(category) as option (option.id)}
                <option value="adopt:{option.id}" disabled={option.disabled}>
                  {option.name}{option.note ? ` — ${option.note}` : ''}
                </option>
              {/each}
            </optgroup>
            <optgroup label="Sinon">
              <option value="create">Créer « {category.name} »</option>
            </optgroup>
          </select>
        {/if}
      </div>
    {/if}

    <!-- ── Les lignes ────────────────────────────────────────────────────── -->
    <div class="space-y-2.5">
      {#each contents as line (line.key)}
        {@const locked = isLocked(line.key)}
        {@const decision = decisionOf(line.key)}
        <div
          class="rounded-xl border px-4 py-3 transition-colors {decision.mode === 'skip'
            ? 'border-outline-variant/20 bg-surface-container-low/20'
            : 'border-outline-variant/30 bg-surface-container-low/40'}"
        >
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0 pt-1.5">
              <p class="flex items-center gap-1.5 text-[13.5px] font-medium text-on-surface truncate">
                <Papicon
                  icon={line.kind === 'role' ? 'shield' : line.kind === 'voice' ? 'mic' : 'message-circle'}
                  size={12}
                  class="shrink-0 text-on-surface-variant/45"
                />
                <span class="truncate {decision.mode === 'skip' ? 'text-on-surface-variant/45 line-through' : ''}">
                  {line.name}
                </span>
              </p>
              {#if locked}
                <p class="mt-1 text-[11.5px] text-primary/70">Posé par Kotbo, déjà relié.</p>
              {:else if isSuggested(line.key)}
                <!-- La ressemblance des noms a trouve quelque chose. Le dire, et
                     ne pas s'en contenter : c'est exactement ce rapprochement
                     silencieux qui produisait les doublons quand il ratait. -->
                <p class="mt-1 text-[11.5px] text-on-surface-variant/55">
                  Détecté sur votre serveur — confirmez ou corrigez.
                </p>
              {:else if decision.mode === 'create'}
                <p class="mt-1 text-[11.5px] text-on-surface-variant/45">
                  Sera créé {destination}.
                </p>
              {/if}
            </div>

            <select
              value={valueOf(line.key)}
              disabled={locked}
              onchange={(event) => choose(line, event.currentTarget.value)}
              class="shrink-0 w-[15.5rem] max-w-[52%] rounded-lg border border-outline-variant/40 bg-surface-container-lowest/60 px-3 py-2 text-[13px] text-on-surface disabled:opacity-50"
            >
              <optgroup label={line.kind === 'role' ? 'Rôles du serveur' : 'Salons du serveur'}>
                {#each candidatesFor(line) as option (option.id)}
                  <option value="adopt:{option.id}" disabled={option.disabled}>
                    {option.name}{option.note ? ` — ${option.note}` : ''}
                  </option>
                {/each}
              </optgroup>
              <optgroup label="Sinon">
                <option value="create">Créer « {line.name} »</option>
                {#if isSkippable(line)}
                  <option value="skip">Ne rien faire</option>
                {/if}
              </optgroup>
            </select>
          </div>
        </div>
      {/each}
    </div>

    {#if dormant.length > 0}
      <!-- Ecarter une ligne est un choix legitime ; le faire sans savoir ce qui
           s'eteint avec elle ne l'est pas. -->
      <div class="rounded-xl border border-outline-variant/30 bg-surface-container-low/30 px-4 py-3">
        <p class="text-[12.5px] text-on-surface-variant leading-relaxed">
          <Papicon icon="info" size={12} class="inline text-on-surface-variant/50 mr-1" />
          {#each dormant as entry, index (entry.key)}{index > 0 ? ', ' : ''}<span class="font-medium text-on-surface">{entry.name}</span>{/each}
          {dormant.length > 1 ? 'resteront éteints' : 'restera éteint'} : le salon qui
          {dormant.length > 1 ? 'les porte' : 'le porte'} a été écarté. Vous pourrez
          {dormant.length > 1 ? 'les' : "l'"} allumer plus tard depuis le tableau de bord.
        </p>
      </div>
    {/if}
  </div>

  {#snippet preview()}
    <div class="rounded-2xl border border-outline-variant/30 bg-surface-container-lowest/50 overflow-hidden">
      <div class="px-4 py-2.5 border-b border-outline-variant/20 flex items-center gap-2">
        <Papicon icon="list" size={12} class="text-on-surface-variant/40" />
        <span class="text-[12.5px] font-semibold text-on-surface">Ce que ça donne</span>
      </div>

      <div class="p-3 space-y-1">
        {#if category && decisionOf(category.key).mode !== 'skip'}
          <p class="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant/40 truncate">
            {decisionOf(category.key).mode === 'adopt'
              ? template?.inventory.channels.find((c) => c.id === decisionOf(category.key).id)?.name ?? category.name
              : category.name}
          </p>
        {/if}

        {#each contents as line (line.key)}
          {@const decision = decisionOf(line.key)}
          {@const adopted = decision.mode === 'adopt'
            ? (line.kind === 'role'
                ? template?.inventory.roles.find((r) => r.id === decision.id)?.name
                : template?.inventory.channels.find((c) => c.id === decision.id)?.name)
            : null}
          <p class="flex items-center gap-2 px-1 text-[13px]">
            {#if decision.mode === 'skip'}
              <Papicon icon="minus" size={11} class="shrink-0 text-on-surface-variant/30" />
              <span class="truncate text-on-surface-variant/35 line-through">{line.name}</span>
            {:else if decision.mode === 'adopt'}
              <Papicon icon="link" size={11} class="shrink-0 text-primary/70" />
              <span class="truncate text-on-surface-variant/85">{adopted ?? line.name}</span>
              <span class="shrink-0 text-[11px] text-on-surface-variant/40">relié</span>
            {:else}
              <Papicon icon="plus" size={11} class="shrink-0 text-emerald-500" />
              <span class="truncate text-on-surface-variant/85">{line.name}</span>
              <span class="shrink-0 text-[11px] text-emerald-600/70">nouveau</span>
            {/if}
          </p>
        {/each}
      </div>

      <div class="px-4 py-2.5 border-t border-outline-variant/20 text-[11.5px] text-on-surface-variant/55">
        {tally.adopted} relié{tally.adopted > 1 ? 's' : ''} ·
        {tally.created} à créer ·
        {tally.skipped} laissé{tally.skipped > 1 ? 's' : ''} de côté
      </div>
    </div>
  {/snippet}

  {#snippet footer()}
    <button
      type="button"
      onclick={() => wizard.complete(wizard.step)}
      class="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-on-primary text-sm font-semibold hover:opacity-90 transition-opacity"
    >
      Continuer
      <Papicon icon="ChevronRight" size={15} />
    </button>
  {/snippet}
</WizardShell>
