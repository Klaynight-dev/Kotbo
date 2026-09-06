<script lang="ts">
  /**
   * Ce que la reprise a relu, montre avant d'etre ecrit.
   *
   * Les autres constats designent un salon : leur intitule suffit a savoir ce
   * qui va se passer. Ceux-la posent un texte devine dans les messages d'un
   * autre bot, et un texte devine se relit. Rien n'est resume ni reformule ici
   * - c'est la valeur exacte qui partira en base, decoupee comme elle le sera.
   *
   * Le bloc est repliable et ferme d'office : dix articles de reglement au
   * milieu d'une liste de propositions noieraient les autres constats.
   */
  import type { InspectionPayload } from '../../stores/onboardingData.svelte';
  import Papicon from '../Papicon.svelte';

  const { payload }: { payload: InspectionPayload } = $props();

  let open = $state(false);

  /** Combien d'elements le repli cache, pour que le bouton le dise. */
  const summary = $derived.by(() => {
    switch (payload.kind) {
      case 'welcome':
        return 'Voir le texte repris';
      case 'rules':
        return `Voir les ${payload.articles.length} articles repris`;
      case 'ticketPanel':
        return payload.types.length > 0
          ? `Voir le panneau et ses ${payload.types.length} sujets`
          : 'Voir le panneau repris';
      case 'reactionRoles':
        return `Voir les ${payload.options.length} rôles repris`;
    }
  });
</script>

<div class="mt-2.5">
  <button
    type="button"
    onclick={() => (open = !open)}
    class="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-on-surface-variant/70
           hover:text-on-surface transition-colors focus:outline-none focus-visible:ring-2
           focus-visible:ring-primary/40 rounded"
    aria-expanded={open}
  >
    <Papicon icon={open ? 'ChevronDown' : 'ChevronRight'} size={12} />
    {summary}
  </button>

  {#if open}
    <div class="mt-2 rounded-lg border border-outline-variant/25 bg-surface-container-lowest/50 p-3">
      {#if payload.kind === 'welcome'}
        <!-- `whitespace-pre-wrap` : les retours a la ligne du message d'origine
             font partie de ce qui est repris, les masquer changerait le texte. -->
        <p class="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-on-surface-variant/85">
          {payload.message}
        </p>
        <p class="mt-2 text-[11px] text-on-surface-variant/50">
          <code class="text-primary/70">{'{user}'}</code> devient la mention de l'arrivant,
          <code class="text-primary/70">{'{server}'}</code> le nom du serveur.
        </p>

      {:else if payload.kind === 'rules'}
        <ol class="space-y-2">
          {#each payload.articles as article, index (article.title + index)}
            <li class="flex gap-2">
              <span class="shrink-0 text-[11.5px] text-on-surface-variant/40 tabular-nums">
                {index + 1}.
              </span>
              <div class="min-w-0">
                <p class="text-[12.5px] font-medium text-on-surface">
                  {#if article.emoji}<span class="mr-1">{article.emoji}</span>{/if}{article.title}
                </p>
                {#if article.description !== article.title}
                  <p class="mt-0.5 whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-on-surface-variant/60">
                    {article.description}
                  </p>
                {/if}
              </div>
            </li>
          {/each}
        </ol>

      {:else if payload.kind === 'ticketPanel'}
        <div class="flex gap-2.5">
          <span
            class="mt-0.5 w-1 shrink-0 rounded-full"
            style="background: {payload.color ?? 'var(--md-sys-color-primary, #5865F2)'}"
          ></span>
          <div class="min-w-0">
            <p class="text-[12.5px] font-semibold text-on-surface">{payload.title}</p>
            <p class="mt-0.5 whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-on-surface-variant/60">
              {payload.description}
            </p>
          </div>
        </div>

        {#if payload.types.length > 0}
          <ul class="mt-2.5 flex flex-wrap gap-1.5">
            {#each payload.types as type (type.id)}
              <li
                class="rounded-md bg-surface-container/70 px-1.5 py-0.5 text-[11.5px] text-on-surface-variant/75"
                title={type.description || undefined}
              >
                {type.emoji} {type.label}
              </li>
            {/each}
          </ul>
        {:else}
          <p class="mt-2.5 text-[11px] text-on-surface-variant/50">
            Bouton « {payload.buttonText} » — aucun sujet à récupérer.
          </p>
        {/if}

      {:else if payload.kind === 'reactionRoles'}
        <p class="text-[12.5px] font-medium text-on-surface">{payload.title}</p>
        <ul class="mt-1.5 space-y-1">
          {#each payload.options as option (option.roleId)}
            <li class="flex items-center gap-2 text-[12px] text-on-surface-variant/75">
              <span class="w-5 text-center">{option.emoji}</span>
              <span class="text-on-surface-variant/40">→</span>
              <span class="truncate">{option.label}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>
