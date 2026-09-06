<script lang="ts">
  /**
   * Mes serveurs : la liste des serveurs Discord que la personne administre,
   * qu'ils aient Kotbo ou non.
   *
   * Le selecteur de serveurs ne montre que les serveurs deja equipes - c'est ce
   * qu'il doit faire, mais on ne peut donc jamais y ajouter le bot ailleurs.
   * Cette page comble le trou : les serveurs sans Kotbo y ont un bouton
   * d'invitation qui preselectionne deja le bon serveur dans la fenetre Discord.
   */
  import { onMount, onDestroy } from 'svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { subscribeRealtime } from '../lib/stores/realtime.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import {
    fetchManageableServers,
    buildBotInviteUrl,
    type ManageableServer,
  } from '../lib/api';
  import { resolveGuildIconSrc } from '../lib/discordMedia';
  import SectionCard from '../lib/components/SectionCard.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import KotboMark from '../lib/components/onboarding/KotboMark.svelte';
  import Papicon from '../lib/components/Papicon.svelte';

  let servers = $state<ManageableServer[]>([]);
  let clientId = $state('');
  let invitePermissions = $state('0');
  let oauthUnavailable = $state(false);
  let loading = $state(true);
  let query = $state('');

  const filtered = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return servers;
    return servers.filter((server) => server.name.toLowerCase().includes(needle));
  });

  const equipped = $derived(filtered.filter((server) => server.botPresent));
  const missing = $derived(filtered.filter((server) => !server.botPresent));

  /** Sans identifiant d'application, aucun lien d'invitation n'est constructible. */
  const canInvite = $derived(!!clientId);

  async function load(refresh = false) {
    loading = true;
    try {
      const result = await fetchManageableServers({ refresh });
      applyServers(result);
    } catch (err: any) {
      toast.error(err?.message || 'La liste des serveurs est indisponible');
      if (servers.length === 0) {
        servers = [];
      }
    } finally {
      loading = false;
    }
  }

  function applyServers(result: Awaited<ReturnType<typeof fetchManageableServers>>) {
    if (result.oauthUnavailable) {
      if (servers.length > 0) {
        toast.error('Impossible d’actualiser la liste des serveurs auprès de Discord.');
        return;
      }
      oauthUnavailable = true;
      clientId = result.clientId;
      invitePermissions = result.invitePermissions;
      servers = [];
      return;
    }

    servers = result.guilds;
    clientId = result.clientId;
    invitePermissions = result.invitePermissions;
    oauthUnavailable = false;
  }

  /**
   * Redemander la liste sans passer par l'ecran de chargement.
   *
   * Un rafraichissement de fond ne doit jamais vider ce qui est affiche : la
   * liste a l'ecran reste valable tant que la nouvelle n'est pas arrivee, et un
   * appel rate n'est pas une raison de la faire disparaitre.
   */
  async function syncServers() {
    try {
      const result = await fetchManageableServers();
      applyServers(result);

      const awaited = pendingGuildId;
      if (awaited && result.guilds.find((guild) => guild.id === awaited)?.botPresent) {
        stopWatching();
        enterServer(awaited);
      }
    } catch {
      // Silencieux : c'est un rafraichissement d'arriere-plan.
    }
  }

  function inviteUrl(guildId?: string): string {
    return buildBotInviteUrl(clientId, invitePermissions, guildId);
  }

  /**
   * Ramener sur la prise en main une fois le bot arrive.
   *
   * L'ecran d'autorisation Discord s'ouvre dans un autre onglet et s'y termine
   * sur une page de fin qui ne renvoie nulle part : sans cela, la personne
   * ferme l'onglet et revient ici sans savoir que c'est fait.
   *
   * On surveille donc depuis cet onglet-ci plutot que par un `redirect_uri` :
   * celui-ci devrait etre declare dans l'application Discord, et une valeur non
   * declaree fait echouer l'autorisation entiere.
   *
   * L'arrivee elle-meme est desormais annoncee par l'API (`bot_guilds_changed`,
   * voir l'abonnement plus bas) : l'entree se fait a la seconde ou le bot
   * rejoint. Le sondage n'est plus que le filet - le WebSocket peut etre coupe,
   * et seul le shard qui porte l'API sait diffuser.
   */
  let pendingGuildId = $state<string | null>(null);
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const POLL_EVERY_MS = 6000;
  /** Deux minutes : au-dela, l'autorisation a ete abandonnee ou a echoue. */
  const POLL_MAX_TRIES = 20;

  function stopWatching() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    pendingGuildId = null;
  }

  function watchForArrival(guildId: string) {
    stopWatching();
    pendingGuildId = guildId;
    let tries = 0;

    pollTimer = setInterval(() => {
      tries += 1;
      if (tries > POLL_MAX_TRIES) {
        stopWatching();
        return;
      }

      // L'onglet est en arriere-plan pendant l'autorisation : inutile de
      // sonder tant que la personne n'est pas revenue.
      if (document.hidden) return;

      void syncServers();
    }, POLL_EVERY_MS);
  }

  /**
   * L'arrivee ou le depart du bot est annonce a tous les onglets ouverts, sans
   * savoir qui administre quoi : c'est ici qu'on trie. Redemander la liste a
   * chaque serveur qui equipe le bot quelque part dans le monde ferait autant
   * d'appels inutiles.
   *
   * Un serveur en cours d'installation ne figure pas encore comme equipe, mais
   * il est bien dans la liste - elle contient aussi ceux ou le bot manque.
   */
  let unsubscribeRealtime: (() => void) | null = null;

  function concernsMe(guildId: unknown): boolean {
    if (typeof guildId !== 'string') return false;
    return pendingGuildId === guildId || servers.some((server) => server.id === guildId);
  }

  onDestroy(() => {
    stopWatching();
    unsubscribeRealtime?.();
  });

  /**
   * Reprendre l'attente au retour de l'ecran d'autorisation Discord.
   *
   * Les liens d'invitation s'ouvrent dans cet onglet-ci : la page est donc
   * detruite pendant l'autorisation, et avec elle la surveillance lancee au
   * clic. Discord ramene ensuite sur le retour d'authentification, qui reconnait
   * une invitation a son `guild_id` et renvoie ici avec `?installed=`.
   *
   * On repart alors sur la meme attente qu'au clic : le bot n'est pas toujours
   * arrive dans notre base a la seconde ou Discord rend la main.
   */
  function resumePendingInstall() {
    const params = new URLSearchParams(window.location.search);
    const installed = params.get('installed');
    if (!installed || !/^\d{17,20}$/.test(installed)) return;

    // Nettoye tout de suite : un rafraichissement ne doit pas relancer
    // l'attente d'une installation deja traitee.
    params.delete('installed');
    const rest = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);

    const target = servers.find((server) => server.id === installed);
    if (target?.botPresent) {
      enterServer(installed);
      return;
    }
    watchForArrival(installed);
  }

  /**
   * Ouvrir le tableau de bord d'un serveur equipe.
   *
   * `setGuild` seul ne suffit pas : la moitie des pages lit la guilde au
   * montage. Le rechargement est ce que fait deja le selecteur de serveurs.
   */
  function openServer(guildId: string) {
    enterServer(guildId);
  }

  /**
   * Ouvrir un serveur, quel que soit son etat.
   *
   * Toujours par un rechargement complet, et jamais par `router.goto` :
   * `setGuild` change bien la guilde retenue, mais `dashboardStore` continue de
   * decrire la precedente - son offre, ses modules, et donc la reponse a
   * « ce serveur a-t-il un tableau de bord ou un parcours de configuration ».
   * Depuis un serveur deja paye, la garde aurait laisse passer vers le
   * dashboard complet celui qui venait tout juste d'installer le bot ailleurs.
   *
   * `/` suffit comme destination : un serveur qui n'a rien pris y sera
   * accueilli par son parcours, un serveur equipe par son tableau de bord.
   * C'est la garde qui tranche, pas cette page.
   */
  function enterServer(guildId: string) {
    authStore.setGuild(guildId);
    window.location.href = '/';
  }

  onMount(async () => {
    unsubscribeRealtime = subscribeRealtime({
      types: ['bot_guilds_changed'],
      // La page parle de tous les serveurs, pas de celui qui est selectionne.
      guildScoped: false,
      onUpdate: (event) => {
        // Un rattrapage (reconnexion, retour d'onglet) n'a pas d'evenement :
        // on ne sait pas ce qui a bouge, donc on redemande.
        if (event && !concernsMe(event.guildId)) return;
        void syncServers();
      },
    });

    await load();
    resumePendingInstall();
  });
</script>

<!--
  Cette page se rend sans MainLayout (voir App.svelte) : elle porte donc
  elle-meme son cadre - fond, largeur, marges - que la coquille fournissait
  jusqu'ici. Le lien de deconnexion est la pour la meme raison : sans barre
  laterale ni en-tete, c'est la seule sortie de la page.
-->
<div class="min-h-screen bg-background text-on-background">
  <div class="mx-auto w-full max-w-5xl px-6 py-10 sm:py-14">
    <div class="mb-8 flex items-center justify-between gap-4">
      <div class="flex items-center gap-2.5">
        <img src="/favicon.svg" alt="" class="w-7 h-7 rounded-lg" />
        <span class="font-semibold tracking-tight text-on-surface">Kotbo</span>
      </div>
      <button
        type="button"
        onclick={() => authStore.logout()}
        class="text-[13px] font-medium text-on-surface-variant/60 hover:text-on-surface transition-colors"
      >
        Se déconnecter
      </button>
    </div>

    <div class="flex flex-col gap-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
  <header class="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-surface-container-low/40 p-5 rounded-xl border border-outline-variant/30 relative overflow-hidden">
    <div class="absolute -top-24 -right-24 w-48 h-48 bg-primary/8 rounded-full blur-[60px]"></div>

    <div class="flex min-w-0 items-center gap-4 relative">
      <div class="w-11 h-11 shrink-0 bg-linear-to-br from-primary to-primary-container rounded-lg flex items-center justify-center shadow-md shadow-primary/15">
        <Papicon icon="Grid" size={22} class="text-white" />
      </div>
      <div class="min-w-0">
        <h1 class="text-lg font-semibold tracking-tight text-on-surface font-headline leading-tight">Mes serveurs</h1>
        <p class="text-sm text-on-surface-variant/70 font-medium">
          Les serveurs que vous administrez, et ceux où Kotbo reste à inviter
        </p>
      </div>
    </div>

    <div class="flex items-center gap-2 relative">
      {#if canInvite}
        <a
          href={inviteUrl()}
          rel="noopener noreferrer"
          class="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-primary text-on-primary text-sm font-medium hover:opacity-90 transition-opacity"
        >
          <Papicon icon="Plus" size={15} />
          Ajouter à un serveur
        </a>
      {/if}
      <RefreshButton onclick={() => void load(true)} {loading} />
    </div>
  </header>

  {#if loading && servers.length === 0}
    <!--
      La liste vient de Discord, pas de Kotbo : l'aller-retour OAuth prend
      parfois plusieurs secondes, et la page restait vide sous son en-tete tout
      ce temps - assez pour croire qu'on n'administre aucun serveur. On montre
      donc d'ou vient l'attente, et la forme de ce qui va la remplir.
    -->
    <div class="flex flex-col items-center gap-4 py-10">
      <KotboMark size={44} halo />
      <div class="text-center">
        <p class="text-[14px] font-semibold text-on-surface">Nous demandons vos serveurs à Discord…</p>
        <p class="mt-1 text-[13px] text-on-surface-variant/60">Quelques secondes, le temps de savoir où Kotbo est déjà là.</p>
      </div>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5" aria-hidden="true">
      {#each [0, 1, 2, 3, 4, 5] as slot (slot)}
        <div class="rounded-xl border border-outline-variant/30 bg-surface-container-low/40 p-3 flex items-center gap-3">
          <div class="w-9 h-9 shrink-0 rounded-lg bg-surface-container animate-pulse"></div>
          <div class="min-w-0 flex-1 space-y-1.5">
            <div class="h-3 rounded bg-surface-container animate-pulse" style="width: {55 + slot * 6}%"></div>
            <div class="h-2.5 w-1/3 rounded bg-surface-container/70 animate-pulse"></div>
          </div>
        </div>
      {/each}
    </div>
  {:else if oauthUnavailable}
    <EmptyState
      icon="alert-triangle"
      title="Discord n'a pas répondu"
      description="La liste de vos serveurs vient de Discord, pas de Kotbo. Réessayez dans un instant."
    >
      {#snippet action()}
        <button
          type="button"
          onclick={() => void load(true)}
          disabled={loading}
          class="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-on-primary text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          <Papicon icon="refresh-cw" size={14} class={loading ? 'animate-spin' : ''} />
          Réessayer
        </button>
      {/snippet}
    </EmptyState>
  {:else}
    <div class="space-y-4">
      {#if servers.length > 3}
        <div class="relative">
          <Papicon icon="Search" size={15} class="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant/40" />
          <input
            type="search"
            bind:value={query}
            placeholder="Rechercher un serveur..."
            class="w-full h-10 pl-9 pr-3 rounded-lg bg-surface-container-low/40 border border-outline-variant/30 text-sm text-on-surface placeholder-on-surface-variant/40 focus:outline-none focus:border-primary/50"
          />
        </div>
      {/if}

      <!-- ── Sans Kotbo : ce pour quoi on vient sur cette page ─────────────── -->
      <SectionCard
        title="Prêts à recevoir Kotbo"
        description="Vous y avez les droits nécessaires, mais le bot n'y est pas encore."
        icon="Plus"
      >
        {#if missing.length === 0}
          <p class="text-[13px] text-on-surface-variant">
            {servers.length === 0
              ? "Aucun serveur où vous ayez la permission « Gérer le serveur »."
              : 'Kotbo est déjà sur tous vos serveurs.'}
          </p>
        {:else}
          <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5">
            {#each missing as server (server.id)}
              {@const icon = resolveGuildIconSrc(server.id, server.icon)}
              <div class="rounded-xl border border-outline-variant/30 bg-surface-container-low/40 p-3 flex items-center gap-3">
                {#if icon}
                  <img src={icon} alt="" referrerpolicy="no-referrer" class="w-9 h-9 rounded-lg object-cover shrink-0" />
                {:else}
                  <div class="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center text-[13px] font-semibold text-primary shrink-0">
                    {server.name.charAt(0)}
                  </div>
                {/if}

                <div class="min-w-0 flex-1">
                  <p class="text-[13px] font-medium text-on-surface truncate">{server.name}</p>
                  <p class="text-[11px] text-on-surface-variant/60">
                    {server.owner ? 'Propriétaire' : 'Administrateur'}
                  </p>
                </div>

                {#if canInvite}
                  <a
                    href={inviteUrl(server.id)}
                    rel="noopener noreferrer"
                    onclick={() => watchForArrival(server.id)}
                    class="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-primary text-on-primary text-xs font-medium hover:opacity-90 transition-opacity"
                  >
                    <Papicon icon="Plus" size={13} />
                    {pendingGuildId === server.id ? 'En attente…' : 'Ajouter'}
                  </a>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </SectionCard>

      <!-- ── Deja equipes ─────────────────────────────────────────────────── -->
      <SectionCard
        title="Serveurs équipés"
        description="Kotbo y est déjà : ouvrez leur tableau de bord d'un clic."
        icon="Grid"
      >
        {#if equipped.length === 0}
          <p class="text-[13px] text-on-surface-variant">
            Kotbo n'est encore sur aucun de vos serveurs.
          </p>
        {:else}
          <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5">
            {#each equipped as server (server.id)}
              {@const icon = resolveGuildIconSrc(server.id, server.icon)}
              {@const isCurrent = server.id === authStore.selectedGuildId}
              <button
                type="button"
                onclick={() => openServer(server.id)}
                class="rounded-xl border bg-surface-container-low/40 p-3 flex items-center gap-3 text-left transition-colors hover:bg-surface-container
                {isCurrent ? 'border-primary/40' : 'border-outline-variant/30'}"
              >
                {#if icon}
                  <img src={icon} alt="" referrerpolicy="no-referrer" class="w-9 h-9 rounded-lg object-cover shrink-0" />
                {:else}
                  <div class="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center text-[13px] font-semibold text-primary shrink-0">
                    {server.name.charAt(0)}
                  </div>
                {/if}

                <div class="min-w-0 flex-1">
                  <p class="text-[13px] font-medium text-on-surface truncate flex items-center gap-1.5">
                    {server.name}
                    {#if isCurrent}
                      <span class="text-[9px] font-medium uppercase tracking-wide px-1 py-0.5 rounded bg-primary/10 text-primary">Actuel</span>
                    {/if}
                  </p>
                  <p class="text-[11px] {server.activated ? 'text-on-surface-variant/60' : 'text-amber-500'}">
                    {server.activated ? (server.owner ? 'Propriétaire' : 'Administrateur') : "En attente d'activation"}
                  </p>
                </div>

                <Papicon icon="ChevronRight" size={14} class="shrink-0 text-on-surface-variant/40" />
              </button>
            {/each}
          </div>
        {/if}
      </SectionCard>
      </div>
    {/if}
    </div>
  </div>
</div>
