<script lang="ts">
  import { getCachedPage, loadPage, type RouteLoader } from '../lazyRoutes';
  import Skeleton from './Skeleton.svelte';
  import { m } from '../i18n';

  let {
    pattern,
    load,
    pageProps = {},
    remountKey = undefined,
  }: {
    pattern: string;
    load: RouteLoader;
    pageProps?: Record<string, unknown>;
    /**
     * Quand cette valeur change, la page est demontee puis remontee au lieu
     * d'etre mise a jour. Reproduit le `{#key ...}` que certaines routes
     * utilisaient pour repartir d'un etat neuf a chaque parametre d'URL.
     */
    remountKey?: unknown;
  } = $props();

  // Si la page a deja ete visitee, on part directement du composant en cache :
  // aucun squelette ne clignote lors d'un retour en arriere.
  const getInitialComponent = () => getCachedPage(pattern);
  let Component = $state<unknown>(getInitialComponent());
  let failed = $state(false);

  $effect(() => {
    if (Component) return;

    let cancelled = false;
    failed = false;

    loadPage(pattern, load)
      .then((component) => {
        if (!cancelled) Component = component;
      })
      .catch(() => {
        if (!cancelled) failed = true;
      });

    return () => {
      cancelled = true;
    };
  });
</script>

{#if Component}
  {@const Page = Component as any}
  {#key remountKey}
    <Page {...pageProps} />
  {/key}
{:else if failed}
  <div class="flex flex-col items-center justify-center gap-3 py-16 text-center">
    <p class="text-on-surface-variant">{m.d1_page_load_failed()}</p>
    <button
      class="rounded-lg bg-primary px-4 py-2 text-on-primary"
      onclick={() => window.location.reload()}
    >
      {m.d1_retry()}
    </button>
  </div>
{:else}
  <!-- Squelette de page : le layout (barre laterale, en-tete) reste visible et
       stable pendant le telechargement du chunk. -->
  <div class="space-y-4 p-6" aria-busy="true">
    <Skeleton height="h-8" width="max-w-xs" />
    <Skeleton height="h-4" width="max-w-md" />
    <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {#each Array(6) as _}
        <Skeleton height="h-28" />
      {/each}
    </div>
  </div>
{/if}
