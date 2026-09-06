<script lang="ts">
  import { onMount } from 'svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import {
    fetchPublicClans,
    searchPublicClans,
    type PublicBetHistoryEntry,
    type PublicBetParticipant,
    type PublicBettorStanding,
    type PublicBettorRewards,
    type PublicClanDebts,
    type PublicClanSearchResult,
    type PublicDebtor,
    EMPTY_CLAN_SEARCH,
  } from '../lib/api';
  import { m, dateLocale, getLocale, locales, type Locale } from '../lib/i18n';
  import { themeStore } from '../lib/stores/theme.svelte';
  import { userPrefs } from '../lib/stores/userPreferences.svelte';

  interface Props {
    serverId: string;
  }
  const { serverId }: Props = $props();

  let loading = $state(true);
  let errorMsg = $state<string | null>(null);
  let guildName = $state('Kotbo Server');
  let guildIcon = $state<string | null>(null);
  let enabled = $state(false);
  let currentClanSeason = $state(1);
  let seasonStartsAt = $state<string | null>(null);
  let seasonEndsAt = $state<string | null>(null);

  interface Participant {
    userId: string;
    /** `null` : trouvé par la recherche, mais aucun point marqué cette saison. */
    rank: number | null;
    xp: number;
    displayName: string;
    avatarUrl: string | null;
  }

  interface ClanData {
    id: string;
    name: string;
    description: string | null;
    roleId: string;
    roleColor: string | null;
    totalXp: number;
    memberCount: number;
    topParticipants: Participant[];
  }

  interface RecentScore {
    id: string;
    amount: number;
    /** Part de la mise payée à crédit : elle n'a bougé aucun score. */
    credit: number;
    source: string; // 'XP' | 'ADMIN' | 'BOOST' | 'DAILY_ALGO' | 'BET' | 'DEBT' | 'DROP' | 'RPG_BOSS' | 'RPG_MOB' | 'RPG_ITEM'
    isClan: boolean;
    userId: string | null;
    displayName: string;
    avatarUrl: string | null;
    clanName: string | null;
    clanColor: string | null;
    createdAt: string;
  }

  const MEMBER_DISPLAY_LIMIT = 10;

  function normalize(s: string): string {
    return s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  }

  let clans = $state<ClanData[]>([]);
  let recentScores = $state<RecentScore[]>([]);
  let searchQuery = $state('');

  // Les onglets « Paris » et « Dettes » n'existent que si le serveur a ouvert la
  // fonctionnalité correspondante : ailleurs, les tables sont vides par
  // construction et l'onglet ne promettrait rien.
  let debts = $state<PublicClanDebts | null>(null);
  let betsEnabled = $state(false);
  let recentBets = $state<PublicBetHistoryEntry[]>([]);
  let bettors = $state<PublicBettorStanding[]>([]);
  // Ce que le podium rapporte à la clôture. `null` quand le serveur ne
  // récompense pas ses parieurs : la colonne des primes disparaît alors, plutôt
  // que d'afficher des zéros qui ressembleraient à une promesse non tenue.
  let bettorRewards = $state<PublicBettorRewards | null>(null);
  let activeTab = $state<'ranking' | 'bets' | 'debts'>('ranking');

  /**
   * Ce que les membres d'un clan doivent encore fermement, en points.
   *
   * Volontairement pas rapporté au score du clan, pour deux raisons. La dette
   * n'a pas de saison alors que les totaux repartent de zéro : le lendemain
   * d'une clôture, le rapport des deux affiche des milliers de pour cent pour
   * une dette qui ne pèse plus sur le classement en cours. Et surtout, une mise
   * à crédit n'ajoute rien au score de son auteur - les points ainsi créés
   * atterrissent chez le gagnant du pari. Présenter la dette d'un clan comme
   * une part de son propre score accuse donc exactement le mauvais camp.
   */
  function clanDebtOwed(clanId: string): number {
    const clan = debts?.clans.find((entry) => entry.id === clanId);
    if (!clan) return 0;
    // Part ferme seulement : le crédit encore engagé dans des paris non tranchés
    // s'efface si le pari tombe, et l'annoncer comme dû promet un remboursement
    // qui n'aura peut-être jamais lieu.
    return Math.max(0, clan.totalDebt - clan.totalEngaged);
  }

  const currentLocale = getLocale();
  function switchLocale(loc: Locale) {
    if (loc === currentLocale) return;
    userPrefs.set('language', loc);
  }

  // Grille : autant de colonnes que de clans (responsive, se replie si trop étroit)
  const clansGridStyle = $derived(
    clans.length > 0
      ? `grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));`
      : ''
  );

  async function loadClans(initial = false) {
    try {
      const res = await fetchPublicClans(serverId);
      if (res) {
        enabled = res.enabled ?? false;
        guildName = res.guildName ?? 'Kotbo Server';
        guildIcon = res.guildIcon ?? null;
        currentClanSeason = res.currentClanSeason ?? 1;
        seasonStartsAt = res.clanSeasonStartsAt ?? null;
        seasonEndsAt = res.clanSeasonEndsAt ?? null;
        clans = res.clans || [];
        recentScores = res.recentScores || [];
        debts = res.debtsEnabled ? (res.debts ?? null) : null;
        betsEnabled = res.betsEnabled ?? false;
        recentBets = res.recentBets ?? [];
        bettors = res.bettors ?? [];
        bettorRewards = res.bettorRewards ?? null;
        // Un onglet peut disparaître entre deux chargements si un administrateur
        // vient de couper la fonctionnalité : mieux vaut retomber sur le
        // classement qu'afficher une section morte.
        if (!debts && activeTab === 'debts') activeTab = 'ranking';
        if (!betsEnabled && activeTab === 'bets') activeTab = 'ranking';
      }
    } catch (err: any) {
      if (!initial) return;
      console.error(err);
      errorMsg = err.message || m.clan_public_error_loading();
    } finally {
      if (initial) loading = false;
    }
  }

  onMount(() => {
    void loadClans(true);
  });

  // La page ne charge que la tête de chaque classement : dès qu'on cherche
  // quelqu'un, c'est le serveur qui le retrouve, calcule son rang réel - même
  // très bas au classement - et renvoie son historique de gains de la saison.
  const searchActive = $derived(searchQuery.trim().length >= 2);
  let searching = $state(false);
  let searchResult = $state<PublicClanSearchResult>({ ...EMPTY_CLAN_SEARCH });
  let searchToken = 0;

  $effect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) {
      searchResult = { ...EMPTY_CLAN_SEARCH };
      searching = false;
      return;
    }
    const token = ++searchToken;
    searching = true;
    const timer = setTimeout(async () => {
      const results = await searchPublicClans(serverId, q);
      if (token !== searchToken) return;
      searchResult = results;
      searching = false;
    }, 300);
    return () => clearTimeout(timer);
  });

  function getDisplayedParticipants(clan: ClanData): Participant[] {
    if (!searchActive) return clan.topParticipants;
    return searchResult.participants.filter(p => p.clanId === clan.id);
  }

  // Nombre de correspondances au-delà de ce qui est affiché, pour inviter à
  // affiner plutôt que de dérouler une liste interminable.
  function getHiddenCount(clan: ClanData, shown: number): number {
    if (!searchActive) return 0;
    return Math.max(0, (searchResult.matchCounts[clan.id] ?? shown) - shown);
  }

  const displayedScores = $derived.by(() => {
    if (!searchActive) return recentScores;
    const q = normalize(searchQuery);
    const local = recentScores.filter(s =>
      normalize(s.displayName).includes(q) || (s.userId ? s.userId.includes(searchQuery) : false)
    );
    const seen = new Set(local.map(s => s.id));
    return [...local, ...searchResult.scores.filter((s: RecentScore) => !seen.has(s.id))];
  });


  /**
   * Listes des onglets Paris et Dettes.
   *
   * Hors recherche, ce sont les têtes de listes envoyées au chargement. Dès
   * qu'on cherche, elles viennent du serveur, comme le classement : filtrer
   * localement ne verrait jamais un pari d'il y a trois semaines ni un endetté
   * hors du haut de tableau, puisque la page ne les a jamais reçus.
   */
  const displayedBettors = $derived(searchActive ? searchResult.bettors : bettors);
  /**
   * Les primes ne s'affichent pas pendant une recherche : le bilan renvoyé
   * alors ne porte que sur les paris des personnes trouvées, il ne dit rien du
   * podium de la saison.
   */
  const showBettorRewards = $derived(!searchActive && bettorRewards !== null);
  const displayedBets = $derived(searchActive ? searchResult.bets : recentBets);

  /**
   * Un pari se joue à deux comme à huit : les noms d'un camp sont donc réduits
   * à une ligne lisible plutôt qu'affichés tous. Le clan n'est précisé que
   * lorsqu'une seule personne compose le camp, sinon la ligne devient un pavé.
   */
  const NAMES_SHOWN = 3;
  function betSideLabel(side: PublicBetParticipant[] | undefined): string {
    const members = side ?? [];
    if (members.length === 0) return '-';

    const shown = members.slice(0, NAMES_SHOWN).map((entry) => entry.displayName).join(', ');
    const hidden = members.length - NAMES_SHOWN;
    if (hidden > 0) return m.clan_public_bets_and_others({ names: shown, count: hidden });

    const clan = members.length === 1 ? members[0].clanName : null;
    return clan ? `${shown} (${clan})` : shown;
  }

  /**
   * Ce que le camp gagnant a pris aux autres, et non le pot : celui-ci contient
   * les mises des vainqueurs, qui leur appartenaient déjà.
   */
  function betNetGain(bet: PublicBetHistoryEntry): number {
    return (bet.winners ?? []).reduce((sum, entry) => sum + entry.netGain, 0);
  }

  // La recherche renvoie une liste plate d'endettés : elle est regroupée par
  // clan pour retrouver les mêmes colonnes que hors recherche.
  const displayedDebtClans = $derived.by(() => {
    if (!debts) return [];
    if (!searchActive) return debts.clans;

    const byClan = new Map<string, { id: string; name: string; roleColor: string | null; totalDebt: number; totalEngaged: number; debtorCount: number; debtors: PublicDebtor[] }>();
    for (const debtor of searchResult.debts) {
      if (!debtor.clanId) continue;
      const existing = byClan.get(debtor.clanId) ?? {
        id: debtor.clanId,
        name: debtor.clanName ?? debtor.clanId,
        roleColor: debtor.clanColor,
        totalDebt: 0,
        totalEngaged: 0,
        debtorCount: 0,
        debtors: [],
      };
      existing.totalDebt += debtor.amount;
      existing.totalEngaged += debtor.engaged;
      existing.debtorCount += 1;
      existing.debtors.push(debtor);
      byClan.set(debtor.clanId, existing);
    }
    return [...byClan.values()].sort((a, b) => b.totalDebt - a.totalDebt);
  });

  const displayedUnaffiliated = $derived(
    searchActive
      ? searchResult.debts.filter((debtor) => !debtor.clanId)
      : (debts?.unaffiliated ?? []),
  );

  /**
   * Totaux de l'onglet Dettes, alignes sur ce qui est affiche.
   *
   * Pendant une recherche, les listes ne montrent que les personnes trouvees :
   * des tuiles restees globales annonceraient un total et un effectif que rien
   * a l'ecran ne justifie, et la moyenne porterait sur une population invisible.
   */
  const debtTotals = $derived.by(() => {
    if (!debts) return { owed: 0, engaged: 0, count: 0, partial: false };
    if (!searchActive) return { owed: debts.total, engaged: debts.totalEngaged, count: debts.debtorCount, partial: false };

    const found = [...displayedDebtClans.flatMap((clan) => clan.debtors), ...displayedUnaffiliated];
    return {
      owed: found.reduce((sum, debtor) => sum + debtor.amount, 0),
      engaged: found.reduce((sum, debtor) => sum + debtor.engaged, 0),
      count: found.length,
      partial: true,
    };
  });

  /**
   * Dette moyenne d'un membre endetté.
   *
   * Volontairement pas un pourcentage du classement : la dette n'a pas de
   * saison - sinon il suffirait d'attendre la clôture pour ne rien devoir -
   * alors que les totaux des clans, eux, repartent de zéro. Rapporter l'une aux
   * autres afficherait des centaines de pour cent au lendemain d'un changement
   * de saison, pour une dette qui ne gonfle plus le classement en cours.
   */
  const debtAverage = $derived(
    debtTotals.count > 0 ? Math.round(debtTotals.owed / debtTotals.count) : 0,
  );

  const debtSearchEmpty = $derived(
    searchActive && displayedDebtClans.length === 0 && displayedUnaffiliated.length === 0,
  );

  const betSearchEmpty = $derived(
    searchActive && displayedBettors.length === 0 && displayedBets.length === 0,
  );

  // Temps relatif localisé (ex: « il y a 2 heures » / "2 hours ago")
  function formatRelativeTime(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const diffMs = Date.now() - then;
    const sec = Math.max(0, Math.floor(diffMs / 1000));
    if (sec < 60) return m.clan_public_just_now();
    const min = Math.floor(sec / 60);
    if (min < 60) return m.clan_public_minutes_ago({ n: min });
    const hours = Math.floor(min / 60);
    if (hours < 24) return m.clan_public_hours_ago({ n: hours });
    const days = Math.floor(hours / 24);
    if (days < 30) return m.clan_public_days_ago({ n: days });
    // Le seuil est la vraie annee, pas douze mois de trente jours : entre les
    // deux, il reste cinq jours qui basculaient sur « il y a 0 an ».
    if (days < 365) return m.clan_public_months_ago({ n: Math.floor(days / 30) });
    return m.clan_public_years_ago({ n: Math.floor(days / 365) });
  }

  function formatSeasonDate(iso: string): string {
    return new Date(iso).toLocaleDateString(dateLocale(), {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }

  const seasonRangeLabel = $derived.by(() => {
    if (seasonStartsAt && seasonEndsAt) {
      return m.clan_public_season_range({
        start: formatSeasonDate(seasonStartsAt),
        end: formatSeasonDate(seasonEndsAt),
      });
    }
    if (seasonStartsAt) return m.clan_public_season_from({ start: formatSeasonDate(seasonStartsAt) });
    if (seasonEndsAt) return m.clan_public_season_until({ end: formatSeasonDate(seasonEndsAt) });
    return null;
  });

  // Le compte à rebours se rafraîchit à la minute : la page reste ouverte
  // longtemps sur un écran de suivi.
  let now = $state(Date.now());
  $effect(() => {
    const interval = setInterval(() => {
      now = Date.now();
      // La bascule de saison est faite par un cron côté bot (toutes les 15 min) :
      // sans resynchronisation, la page resterait figée sur « Saison terminée »
      // et sur l'ancien classement jusqu'à un rechargement manuel.
      if (seasonEndsAt && now >= new Date(seasonEndsAt).getTime()) void loadClans();
    }, 60_000);
    return () => clearInterval(interval);
  });

  const seasonCountdown = $derived.by(() => {
    if (seasonStartsAt) {
      const start = new Date(seasonStartsAt).getTime();
      if (!Number.isNaN(start) && start > now) {
        return {
          text: m.clan_public_season_starts_in({ n: Math.ceil((start - now) / 86_400_000) }),
          ended: false,
        };
      }
    }
    if (!seasonEndsAt) return null;
    const end = new Date(seasonEndsAt).getTime();
    if (Number.isNaN(end)) return null;
    const diff = end - now;
    if (diff <= 0) return { text: m.clan_public_season_ended(), ended: true };
    const days = Math.floor(diff / 86_400_000);
    if (days >= 1) return { text: m.clan_public_season_days_left({ n: days }), ended: false };
    const hours = Math.floor(diff / 3_600_000);
    const minutes = Math.floor((diff % 3_600_000) / 60_000);
    return { text: m.clan_public_season_hours_left({ h: hours, min: minutes }), ended: false };
  });

  function getRankBadgeColor(rank: number | null) {
    if (rank === null) return 'bg-slate-100 dark:bg-slate-800 text-slate-400';
    if (rank === 1) return 'bg-amber-500/10 text-amber-500 border border-amber-500/20';
    if (rank === 2) return 'bg-slate-400/10 text-slate-400 border border-slate-400/20';
    if (rank === 3) return 'bg-amber-700/10 text-amber-700 border border-amber-700/20';
    return 'bg-slate-100 dark:bg-slate-800 text-slate-500';
  }
</script>

<svelte:head>
  <title>{m.clan_public_page_title({ guildName })}</title>
  <meta name="description" content={m.clan_public_meta_desc({ guildName })} />
</svelte:head>

<div class="min-h-screen whiteboard-container relative overflow-x-hidden selection:bg-yellow-100 dark:selection:bg-slate-850 py-12 px-4 sm:px-6 z-10">
  
  <div class="relative z-10 w-full max-w-6xl mx-auto space-y-10 animate-in fade-in duration-300">

    <!-- ─── En-tête style Feuille Index épuré ─── -->
    <header class="relative flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 p-5 rounded-lg shadow-sm overflow-hidden group">
      <div class="tape-accent"></div>

      <div class="flex items-center gap-4">
        {#if guildIcon}
          <div class="relative shrink-0">
            <img src={guildIcon} alt="{guildName} Logo" class="w-11 h-11 rounded-lg object-cover border border-slate-200 dark:border-slate-800" />
          </div>
        {:else}
          <div class="relative w-11 h-11 bg-slate-50 dark:bg-[#0c1322] border border-slate-200 dark:border-slate-800 rounded-lg flex items-center justify-center font-bold text-sm text-slate-800 dark:text-slate-100 shrink-0">
            <span>{guildName.slice(0, 2).toUpperCase()}</span>
          </div>
        {/if}

        <div class="relative">
          <h1 class="text-lg font-extrabold tracking-tight text-slate-800 dark:text-slate-100">
            {guildName}
          </h1>
          <div class="flex items-center gap-1.5 text-slate-500 dark:text-slate-400 font-semibold text-xs uppercase tracking-wider">
            <span class="text-amber-500"><Papicon icon="Shield" size={14} /></span>
            <span>{m.clan_public_header_subtitle({ n: currentClanSeason })}</span>
          </div>

          {#if seasonRangeLabel || seasonCountdown}
            <div class="flex flex-wrap items-center gap-2 mt-1.5">
              {#if seasonRangeLabel}
                <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-slate-50 dark:bg-[#0c1322] border border-slate-200 dark:border-slate-800 text-[10px] font-bold text-slate-500 dark:text-slate-400">
                  <Papicon icon="Calendar" size={12} />
                  {seasonRangeLabel}
                </span>
              {/if}
              {#if seasonCountdown}
                <span
                  class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold border {seasonCountdown.ended
                    ? 'bg-slate-100 dark:bg-slate-800/60 border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400'
                    : 'bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-400'}"
                >
                  <Papicon icon="Clock" size={12} />
                  {seasonCountdown.text}
                </span>
              {/if}
            </div>
          {/if}
        </div>
      </div>

      <div class="flex items-center gap-3 self-start sm:self-auto">
        <!-- Sélecteur de langue -->
        <div class="flex items-center rounded-full border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0c1322] p-0.5 text-[10px] font-bold uppercase tracking-wider">
          {#each locales as loc}
            <button
              type="button"
              onclick={() => switchLocale(loc)}
              class="px-2.5 py-1 rounded-full transition-colors {currentLocale === loc ? 'bg-white dark:bg-[#111a2e] text-slate-800 dark:text-slate-100 shadow-sm' : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'}"
            >{loc}</button>
          {/each}
        </div>

        <!-- Bascule thème clair/sombre -->
        <button
          type="button"
          onclick={themeStore.toggle}
          aria-label={m.navbar_change_theme()}
          class="w-8 h-8 rounded-full border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0c1322] flex items-center justify-center text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
        >
          {#if themeStore.dark}
            <Papicon icon="sun" size={15} class="text-amber-500" />
          {:else}
            <Papicon icon="moon" size={15} />
          {/if}
        </button>

        <!-- Badge "Live" -->
        <div class="relative flex items-center gap-2 px-3 py-1.5 rounded-full border border-emerald-500/20 dark:border-emerald-500/10 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400 text-xs font-bold">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span>
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 absolute"></span>
          <span class="ml-2.5 uppercase tracking-wider text-[10px]">{m.clan_public_live_badge()}</span>
        </div>
      </div>
    </header>

    {#if loading}
      <!-- Loading Skeletons -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
        <Skeleton height="500px" radius="1.25rem" />
        <Skeleton height="500px" radius="1.25rem" />
      </div>
    {:else if errorMsg}
      <!-- Error Message -->
      <div class="bg-white dark:bg-[#111a2e] border border-red-200 dark:border-red-950 p-12 rounded-lg text-center space-y-4 shadow-sm">
        <div class="w-12 h-12 bg-red-50 dark:bg-red-950/35 rounded-full flex items-center justify-center text-red-500 dark:text-red-400 mx-auto">
          <Papicon icon="AlertTriangle" size={20} />
        </div>
        <div class="space-y-1.5">
          <p class="text-slate-800 dark:text-slate-100 font-extrabold text-lg">{m.clan_public_error_title()}</p>
          <p class="text-slate-505 dark:text-slate-400 text-sm max-w-md mx-auto">{errorMsg}</p>
        </div>
      </div>
    {:else if !enabled || clans.length === 0}
      <!-- Module disabled -->
      <div class="bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 p-16 rounded-lg text-center flex flex-col items-center space-y-4 shadow-sm">
        <div class="w-14 h-14 rounded-full bg-slate-50 dark:bg-[#0c1322] flex items-center justify-center text-slate-400">
          <Papicon icon="Lock" size={24} />
        </div>
        <div class="space-y-1.5 max-w-sm">
          <h2 class="text-xl font-bold text-slate-800 dark:text-slate-100">{m.clan_public_disabled_title()}</h2>
          <p class="text-slate-500 dark:text-slate-400 text-sm leading-relaxed">
            {m.clan_public_disabled_desc()}
          </p>
        </div>
      </div>
    {:else}
      <!-- ─── Search Bar ─── -->
      <div class="relative max-w-md mx-auto group">
        <span class="absolute inset-y-0 left-4 flex items-center text-slate-400 group-focus-within:text-slate-500 transition-colors">
          <Papicon icon="Search" size={16} />
        </span>
        <input
          type="text"
          bind:value={searchQuery}
          placeholder={m.clan_public_search_placeholder()}
          class="w-full pl-11 pr-11 py-3 bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 rounded-lg text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500/50 shadow-sm transition-all"
        />
        {#if searchQuery}
          <button
            type="button"
            onclick={() => searchQuery = ''}
            aria-label={m.clan_public_search_placeholder()}
            class="absolute right-3.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-slate-200 dark:bg-slate-750 hover:bg-red-100 dark:hover:bg-red-950/45 hover:text-red-750 dark:hover:text-red-300 text-slate-500 dark:text-slate-400 flex items-center justify-center text-[11px] font-bold transition-all"
          >✕</button>
        {/if}
      </div>

      {#if betsEnabled || debts}
        <div class="flex flex-wrap justify-center gap-2 relative z-10">
          <button
            type="button"
            onclick={() => activeTab = 'ranking'}
            class="px-5 py-2.5 rounded-lg text-xs font-bold uppercase tracking-widest transition-all cursor-pointer border {activeTab === 'ranking' ? 'bg-amber-500/10 border-amber-500/40 text-amber-600 dark:text-amber-400' : 'bg-white dark:bg-[#111a2e] border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}"
          >
            {m.clan_public_tab_ranking()}
          </button>
          {#if betsEnabled}
            <button
              type="button"
              onclick={() => activeTab = 'bets'}
              class="px-5 py-2.5 rounded-lg text-xs font-bold uppercase tracking-widest transition-all cursor-pointer border {activeTab === 'bets' ? 'bg-indigo-500/10 border-indigo-500/40 text-indigo-600 dark:text-indigo-400' : 'bg-white dark:bg-[#111a2e] border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}"
            >
              {m.clan_public_tab_bets()}
            </button>
          {/if}
          {#if debts}
            <button
              type="button"
              onclick={() => activeTab = 'debts'}
              class="px-5 py-2.5 rounded-lg text-xs font-bold uppercase tracking-widest transition-all cursor-pointer border {activeTab === 'debts' ? 'bg-rose-500/10 border-rose-500/40 text-rose-600 dark:text-rose-400' : 'bg-white dark:bg-[#111a2e] border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}"
            >
              {m.clan_public_tab_debts()}
            </button>
          {/if}
        </div>
      {/if}

      {#if activeTab === 'ranking'}
      <!-- ─── Side-by-side Clans Column Grid (une colonne par clan) ─── -->
      <div class="grid gap-8 items-start relative z-10" style={clansGridStyle}>
        
        {#each clans as clan}
          {@const pList = getDisplayedParticipants(clan).slice(0, MEMBER_DISPLAY_LIMIT)}
          {@const hiddenCount = getHiddenCount(clan, pList.length)}
          {@const debtOwed = clanDebtOwed(clan.id)}
          
          <div
            class="clean-card bg-white dark:bg-[#111a2e] border-t-4 border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm transition-transform hover:-translate-y-0.5 duration-300 overflow-hidden"
            style="border-top-color: {clan.roleColor || '#e2e8f0'};"
          >
            <!-- Clan Header -->
            <div class="p-6 border-b border-slate-100 dark:border-slate-800 space-y-4">
              <div class="flex items-center justify-between">
                <h2 class="text-xl font-extrabold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                  <span class="inline-block w-3.5 h-3.5 rounded-full" style="background-color: {clan.roleColor || '#e2e8f0'};"></span>
                  {clan.name}
                </h2>
                
                <span class="px-3 py-1 bg-slate-50 dark:bg-[#0c1322] border border-slate-200/50 dark:border-slate-800 rounded-full text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                  {m.clan_public_member_count({ n: clan.memberCount })}
                </span>
              </div>

              <!-- Score Card -->
              <div class="flex items-center justify-between p-3.5 rounded-xl bg-slate-50/50 dark:bg-[#0c1322]/50 border border-slate-200/10">
                <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{m.clan_public_season_xp_label()}</span>
                <div class="flex items-center gap-2">
                  {#if debtOwed > 0}
                    <span
                      class="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-500 border border-rose-500/20"
                      title={m.clan_public_credit_badge_hint()}
                    >
                      {m.clan_public_credit_badge({ amount: debtOwed.toLocaleString(dateLocale()) })}
                    </span>
                  {/if}
                  <span class="text-lg font-black text-amber-500 tracking-tight">
                    {clan.totalXp.toLocaleString(dateLocale())} XP
                  </span>
                </div>
              </div>
            </div>

            <!-- Participants list -->
            <div class="p-4">
              {#if searching && pList.length === 0}
                <div class="py-12 text-center text-xs text-slate-400 dark:text-slate-500 italic">
                  {m.clan_public_searching()}
                </div>
              {:else if pList.length === 0}
                <div class="py-12 text-center text-xs text-slate-400 dark:text-slate-500 italic">
                  {m.clan_public_no_members_found()}
                </div>
              {:else}
                <div class="space-y-1.5">
                  {#each pList as p}
                    <div class="flex items-center justify-between p-2.5 hover:bg-slate-50/50 dark:hover:bg-slate-800/20 rounded-xl transition-all duration-200 group/item">
                      <div class="flex items-center gap-3 min-w-0">

                        <!-- Rank Badge -->
                        <span class="min-w-6 h-6 px-1.5 rounded-md flex items-center justify-center text-xs font-black shrink-0 tabular-nums whitespace-nowrap {getRankBadgeColor(p.rank)}">
                          {p.rank ?? '-'}
                        </span>

                        <!-- User avatar -->
                        {#if p.avatarUrl}
                          <img src={p.avatarUrl} alt={p.displayName} class="w-8 h-8 rounded-full border border-slate-200/50 dark:border-slate-800" />
                        {:else}
                          <div class="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-xs font-bold text-slate-500 uppercase shrink-0">
                            {p.displayName.slice(0, 2)}
                          </div>
                        {/if}

                        <span class="text-sm font-bold text-slate-700 dark:text-slate-350 truncate max-w-[160px] sm:max-w-xs group-hover/item:text-slate-900 dark:group-hover/item:text-slate-100 transition-colors">
                          {p.displayName}
                        </span>
                      </div>

                      {#if p.rank === null}
                        <span class="text-[10px] font-bold text-slate-400 dark:text-slate-500 italic shrink-0 pl-2">
                          {m.clan_public_no_points_yet()}
                        </span>
                      {:else}
                        <span class="text-xs font-extrabold text-amber-500 tracking-tight shrink-0 pl-2">
                          {p.xp.toLocaleString(dateLocale())} XP
                        </span>
                      {/if}
                    </div>
                  {/each}
                </div>

                {#if hiddenCount > 0}
                  <p class="pt-3 text-center text-[11px] text-slate-400 dark:text-slate-500 italic">
                    {m.clan_public_more_results({ n: hiddenCount })}
                  </p>
                {/if}
              {/if}
            </div>

          </div>
        {/each}

      </div>
      {:else if activeTab === 'bets'}
        {#if searching}
          <div class="clean-card bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 rounded-2xl py-16 text-center text-xs text-slate-400 dark:text-slate-500 italic relative z-10">
            {m.clan_public_searching()}
          </div>
        {:else if betSearchEmpty}
          <div class="clean-card bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 rounded-2xl py-16 text-center text-xs text-slate-400 dark:text-slate-500 italic relative z-10">
            {m.clan_public_search_no_match()}
          </div>
        {:else if bettors.length === 0 && recentBets.length === 0}
          <div class="clean-card bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 rounded-2xl py-16 text-center text-xs text-slate-400 dark:text-slate-500 italic relative z-10">
            {m.clan_public_bets_empty()}
          </div>
        {:else}
          {#if displayedBettors.length > 0}
            <!-- ─── Palmarès des parieurs de la saison ─── -->
            <section class="clean-card bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm overflow-hidden relative">
              <div class="px-6 pt-6 pb-4 border-b border-slate-100 dark:border-slate-800">
                <h2 class="text-sm font-black uppercase tracking-widest text-slate-700 dark:text-slate-200 flex items-center gap-2">
                  <span class="text-indigo-500"><Papicon icon="Trophy" size={16} /></span>
                  {m.clan_public_bettors_title()}
                </h2>
                <p class="text-[11px] text-slate-400 dark:text-slate-500 mt-1">{m.clan_public_bettors_desc()}</p>
                {#if showBettorRewards && bettorRewards}
                  <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
                    <span class="text-amber-500"><Papicon icon="Trophy" size={12} /></span>
                    <span>{m.clan_public_bettors_rewards({
                      top1: bettorRewards.top1.toLocaleString(dateLocale()),
                      top2: bettorRewards.top2.toLocaleString(dateLocale()),
                      top3: bettorRewards.top3.toLocaleString(dateLocale()),
                    })}</span>
                    {#if bettorRewards.roleName}
                      <span>{m.clan_public_bettors_rewards_role({ role: `@${bettorRewards.roleName}` })}</span>
                    {/if}
                  </p>
                {/if}
              </div>

              <div class="overflow-x-auto">
                <table class="w-full text-left border-collapse">
                  <thead>
                    <tr class="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">
                      <th class="px-6 py-3">#</th>
                      <th class="px-6 py-3">{m.clan_public_col_user()}</th>
                      <th class="px-6 py-3 text-center">{m.clan_public_bettors_col_record()}</th>
                      <th class="px-6 py-3 text-center">{m.clan_public_bettors_col_streak()}</th>
                      <th class="px-6 py-3 text-right">{m.clan_public_bettors_col_net()}</th>
                      {#if showBettorRewards}
                        <th class="px-6 py-3 text-right">{m.clan_public_bettors_col_reward()}</th>
                      {/if}
                    </tr>
                  </thead>
                  <tbody>
                    {#each displayedBettors as bettor, i}
                      <tr class="text-sm {i % 2 === 0 ? 'bg-slate-50/60 dark:bg-[#0c1322]/40' : ''}">
                        <td class="px-6 py-3">
                          <span class="min-w-6 h-6 px-1.5 rounded-md inline-flex items-center justify-center text-xs font-black tabular-nums {getRankBadgeColor(searchActive ? null : i + 1)}">{i + 1}</span>
                        </td>
                        <td class="px-6 py-3">
                          <div class="flex items-center gap-2.5 min-w-0">
                            {#if bettor.avatarUrl}
                              <img src={bettor.avatarUrl} alt={bettor.displayName} class="w-6 h-6 rounded-full border border-slate-200/50 dark:border-slate-800 shrink-0" />
                            {:else}
                              <div class="w-6 h-6 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-[9px] font-bold text-slate-500 uppercase shrink-0">{bettor.displayName.slice(0, 2)}</div>
                            {/if}
                            <span class="font-semibold text-slate-700 dark:text-slate-200 truncate">{bettor.displayName}</span>
                          </div>
                        </td>
                        <td class="px-6 py-3 text-center whitespace-nowrap text-xs font-bold">
                          <span class="text-emerald-600 dark:text-emerald-400">{bettor.wins}</span>
                          <span class="text-slate-300 dark:text-slate-600 px-0.5">/</span>
                          <span class="text-red-500">{bettor.losses}</span>
                        </td>
                        <td class="px-6 py-3 text-center whitespace-nowrap">
                          {#if bettor.bestStreak > 1}
                            <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-500 border border-amber-500/20">
                              {m.clan_public_bettors_streak({ n: bettor.bestStreak })}
                            </span>
                          {:else}
                            <span class="text-slate-300 dark:text-slate-600">-</span>
                          {/if}
                        </td>
                        <td class="px-6 py-3 text-right whitespace-nowrap">
                          <span class="font-black tracking-tight {bettor.netGain >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}">
                            {bettor.netGain >= 0 ? '+' : ''}{bettor.netGain.toLocaleString(dateLocale())}
                          </span>
                        </td>
                        {#if showBettorRewards}
                          <td class="px-6 py-3 text-right whitespace-nowrap">
                            <!-- Seules les marches réellement occupées portent une
                                 prime : un gain net nul ou négatif ne monte pas
                                 sur le podium, et sa case reste vide. -->
                            {#if bettor.reward > 0}
                              <div class="inline-flex items-center gap-1.5">
                                {#if bettor.podiumRank === 1 && bettorRewards?.roleName}
                                  <!-- Aux couleurs du rôle mis en jeu quand il en a une :
                                       c'est ce badge-là que le premier portera sur Discord. -->
                                  <span
                                    class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border {bettorRewards.roleColor ? '' : 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20'}"
                                    style={bettorRewards.roleColor
                                      ? `color:${bettorRewards.roleColor};border-color:${bettorRewards.roleColor}40;background:${bettorRewards.roleColor}1a`
                                      : ''}
                                    title={`@${bettorRewards.roleName}`}
                                  >
                                    {m.clan_public_bettors_top1()}
                                  </span>
                                {/if}
                                <span class="text-[11px] font-black tabular-nums px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-500 border border-amber-500/20">
                                  {m.clan_public_bettors_reward_amount({ amount: bettor.reward.toLocaleString(dateLocale()) })}
                                </span>
                              </div>
                            {:else}
                              <span class="text-slate-300 dark:text-slate-600">-</span>
                            {/if}
                          </td>
                        {/if}
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            </section>
          {/if}

          {#if displayedBets.length > 0}
            <!-- ─── Derniers paris tranchés ─── -->
            <section class="clean-card bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm overflow-hidden relative">
              <div class="px-6 pt-6 pb-4 border-b border-slate-100 dark:border-slate-800">
                <h2 class="text-sm font-black uppercase tracking-widest text-slate-700 dark:text-slate-200 flex items-center gap-2">
                  <span class="text-indigo-500"><Papicon icon="Sparkles" size={16} /></span>
                  {m.clan_public_bets_title()}
                </h2>
                <p class="text-[11px] text-slate-400 dark:text-slate-500 mt-1">{m.clan_public_bets_desc()}</p>
              </div>

              <div class="p-4 space-y-2">
                {#each displayedBets as bet}
                  <div class="p-3.5 rounded-xl bg-slate-50/50 dark:bg-[#0c1322]/40 border border-slate-200/10 space-y-2">
                    <div class="flex items-start justify-between gap-4">
                      <span class="text-sm font-bold text-slate-700 dark:text-slate-200 min-w-0">{bet.subject}</span>
                      <span class="text-[11px] text-slate-400 dark:text-slate-500 shrink-0 whitespace-nowrap">{formatRelativeTime(bet.resolvedAt)}</span>
                    </div>

                    <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
                      <span class="inline-flex items-center gap-1.5 font-bold text-emerald-600 dark:text-emerald-400 min-w-0">
                        <Papicon icon="Crown" size={14} />
                        <span class="truncate">{betSideLabel(bet.winners)}</span>
                        {#if bet.winningSideLabel && (bet.winners?.length ?? 0) > 1}
                          <span class="font-normal text-slate-400 dark:text-slate-500">({bet.winningSideLabel})</span>
                        {/if}
                      </span>
                      <span class="text-slate-300 dark:text-slate-600">vs</span>
                      <span class="inline-flex items-center gap-1.5 font-semibold text-slate-500 dark:text-slate-400 min-w-0">
                        <span class="truncate">{betSideLabel(bet.losers)}</span>
                      </span>
                      <span class="ml-auto font-black tracking-tight text-emerald-600 dark:text-emerald-400 whitespace-nowrap">
                        +{betNetGain(bet).toLocaleString(dateLocale())}
                      </span>
                      {#if bet.creditUsed > 0}
                        <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-500 border border-rose-500/20 whitespace-nowrap">
                          {m.clan_public_bets_on_credit({ amount: bet.creditUsed.toLocaleString(dateLocale()) })}
                        </span>
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
            </section>
          {/if}
        {/if}
      {:else if debts}
        <!-- ─── Onglet Dettes : mêmes colonnes, même lecture ─── -->
        <div class="grid gap-4 sm:grid-cols-3 relative z-10">
          <div class="clean-card bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 rounded-2xl p-5">
            <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{m.clan_public_debt_total_label()}</p>
            <p class="text-2xl font-black text-rose-500 tracking-tight mt-1">{debtTotals.owed.toLocaleString(dateLocale())}</p>
            {#if debtTotals.engaged > 0}
              <p class="text-[10px] text-slate-400 dark:text-slate-500 mt-1 leading-snug" title={m.clan_public_debt_engaged_desc()}>
                {m.clan_public_debt_engaged_hint({ amount: debtTotals.engaged.toLocaleString(dateLocale()) })}
              </p>
            {/if}
          </div>
          <div class="clean-card bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 rounded-2xl p-5">
            <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{m.clan_public_debt_people_label()}</p>
            <p class="text-2xl font-black text-slate-700 dark:text-slate-200 tracking-tight mt-1">{debtTotals.count.toLocaleString(dateLocale())}</p>
            {#if debtTotals.partial}
              <p class="text-[10px] text-slate-400 dark:text-slate-500 mt-1 leading-snug">{m.clan_public_debt_search_scope()}</p>
            {/if}
          </div>
          <div class="clean-card bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 rounded-2xl p-5">
            <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{m.clan_public_debt_average_label()}</p>
            <p class="text-2xl font-black text-amber-500 tracking-tight mt-1">{debtAverage.toLocaleString(dateLocale())}</p>
            <p class="text-[10px] text-slate-400 dark:text-slate-500 mt-1 leading-snug">{m.clan_public_debt_average_hint()}</p>
          </div>
        </div>

        {#if searching}
          <div class="clean-card bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 rounded-2xl py-16 text-center text-xs text-slate-400 dark:text-slate-500 italic relative z-10">
            {m.clan_public_searching()}
          </div>
        {:else if debtSearchEmpty}
          <div class="clean-card bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 rounded-2xl py-16 text-center text-xs text-slate-400 dark:text-slate-500 italic relative z-10">
            {m.clan_public_search_no_match()}
          </div>
        {:else if debts.debtorCount === 0}
          <div class="clean-card bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 rounded-2xl py-16 text-center text-xs text-slate-400 dark:text-slate-500 italic relative z-10">
            {m.clan_public_debt_empty()}
          </div>
        {:else}
          <div class="grid gap-8 items-start relative z-10" style={clansGridStyle}>
            {#each displayedDebtClans as clan}
              <div
                class="clean-card bg-white dark:bg-[#111a2e] border-t-4 border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm transition-transform hover:-translate-y-0.5 duration-300 overflow-hidden"
                style="border-top-color: {clan.roleColor || '#e2e8f0'};"
              >
                <div class="p-6 border-b border-slate-100 dark:border-slate-800 space-y-4">
                  <div class="flex items-center justify-between">
                    <h2 class="text-xl font-extrabold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                      <span class="inline-block w-3.5 h-3.5 rounded-full" style="background-color: {clan.roleColor || '#e2e8f0'};"></span>
                      {clan.name}
                    </h2>
                    <span class="px-3 py-1 bg-slate-50 dark:bg-[#0c1322] border border-slate-200/50 dark:border-slate-800 rounded-full text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                      {m.clan_public_debt_debtors({ n: clan.debtorCount })}
                    </span>
                  </div>

                  <div class="flex items-center justify-between p-3.5 rounded-xl bg-slate-50/50 dark:bg-[#0c1322]/50 border border-slate-200/10">
                    <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{m.clan_public_debt_clan_total()}</span>
                    <span class="text-right">
                      <span class="block text-lg font-black text-rose-500 tracking-tight">
                        {clan.totalDebt.toLocaleString(dateLocale())}
                      </span>
                      {#if clan.totalEngaged > 0}
                        <span class="block text-[10px] text-slate-400 dark:text-slate-500 leading-snug">
                          {m.clan_public_debt_engaged_hint({ amount: clan.totalEngaged.toLocaleString(dateLocale()) })}
                        </span>
                      {/if}
                    </span>
                  </div>
                </div>

                <div class="p-4">
                  {#if clan.debtors.length === 0}
                    <div class="py-12 text-center text-xs text-slate-400 dark:text-slate-500 italic">
                      {m.clan_public_debt_clan_clear()}
                    </div>
                  {:else}
                    <div class="space-y-1.5">
                      {#each clan.debtors as debtor, i}
                        <div class="flex items-center justify-between p-2.5 hover:bg-slate-50/50 dark:hover:bg-slate-800/20 rounded-xl transition-all duration-200">
                          <div class="flex items-center gap-3 min-w-0">
                            <span class="min-w-6 h-6 px-1.5 rounded-md flex items-center justify-center text-xs font-black shrink-0 tabular-nums bg-rose-500/10 text-rose-500">
                              {i + 1}
                            </span>
                            {#if debtor.avatarUrl}
                              <img src={debtor.avatarUrl} alt={debtor.displayName} class="w-8 h-8 rounded-full border border-slate-200/50 dark:border-slate-800" />
                            {:else}
                              <div class="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-xs font-bold text-slate-500 uppercase shrink-0">
                                {debtor.displayName.slice(0, 2)}
                              </div>
                            {/if}
                            <span class="text-sm font-bold text-slate-700 dark:text-slate-350 truncate max-w-[160px] sm:max-w-xs">
                              {debtor.displayName}
                            </span>
                          </div>
                          <span class="shrink-0 pl-2 text-right">
                            <span class="block text-xs font-extrabold text-rose-500 tracking-tight">
                              -{debtor.amount.toLocaleString(dateLocale())}
                            </span>
                            {#if debtor.engaged > 0}
                              <span class="block text-[10px] text-slate-400 dark:text-slate-500 leading-snug">
                                {m.clan_public_debt_engaged_hint({ amount: debtor.engaged.toLocaleString(dateLocale()) })}
                              </span>
                            {/if}
                          </span>
                        </div>
                      {/each}
                      {#if clan.debtorCount > clan.debtors.length}
                        <p class="text-[10px] text-center text-slate-400 dark:text-slate-500 italic pt-1">
                          {m.clan_public_more_results({ n: clan.debtorCount - clan.debtors.length })}
                        </p>
                      {/if}
                    </div>
                  {/if}
                </div>
              </div>
            {/each}
          </div>

          {#if displayedUnaffiliated.length > 0}
            <section class="clean-card bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm overflow-hidden relative z-10">
              <div class="px-6 pt-6 pb-4 border-b border-slate-100 dark:border-slate-800">
                <h2 class="text-sm font-black uppercase tracking-widest text-slate-700 dark:text-slate-200">{m.clan_public_debt_unaffiliated_title()}</h2>
                <p class="text-[11px] text-slate-400 dark:text-slate-500 mt-1">{m.clan_public_debt_unaffiliated_desc()}</p>
              </div>
              <div class="p-4 space-y-1.5">
                {#each displayedUnaffiliated as debtor}
                  <div class="flex items-center justify-between p-2.5 rounded-xl">
                    <span class="text-sm font-bold text-slate-700 dark:text-slate-350 truncate">{debtor.displayName}</span>
                    <span class="shrink-0 pl-2 text-right">
                      <span class="block text-xs font-extrabold text-rose-500 tracking-tight">-{debtor.amount.toLocaleString(dateLocale())}</span>
                      {#if debtor.engaged > 0}
                        <span class="block text-[10px] text-slate-400 dark:text-slate-500 leading-snug">
                          {m.clan_public_debt_engaged_hint({ amount: debtor.engaged.toLocaleString(dateLocale()) })}
                        </span>
                      {/if}
                    </span>
                  </div>
                {/each}
              </div>
            </section>
          {/if}
        {/if}
      {/if}

      <!-- ─── Section « Derniers Scores » ─── -->
      <section class="clean-card bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm overflow-hidden relative">
        <div class="px-6 pt-6 pb-4 border-b border-slate-100 dark:border-slate-800">
          <h2 class="text-sm font-black uppercase tracking-widest text-slate-700 dark:text-slate-200 flex items-center gap-2">
            <span class="text-emerald-500"><Papicon icon="Activity" size={16} /></span>
            {m.clan_public_recent_scores_title()}
          </h2>
          <p class="text-[11px] text-slate-400 dark:text-slate-500 mt-1">{m.clan_public_recent_scores_desc()}</p>
        </div>

        {#if displayedScores.length === 0}
          <div class="py-14 text-center text-xs text-slate-400 dark:text-slate-500 italic">
            {m.clan_public_no_recent_scores()}
          </div>
        {:else}
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse">
              <thead>
                <tr class="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">
                  <th class="px-6 py-3">{m.clan_public_col_date()}</th>
                  <th class="px-6 py-3">{m.clan_public_col_user()}</th>
                  <th class="px-6 py-3">{m.clan_public_col_source()}</th>
                  <th class="px-6 py-3 text-right">{m.clan_public_col_score()}</th>
                </tr>
              </thead>
              <tbody>
                {#each displayedScores as s, i}
                  <tr class="text-sm {i % 2 === 0 ? 'bg-slate-50/60 dark:bg-[#0c1322]/40' : ''}">
                    <td class="px-6 py-3 text-slate-500 dark:text-slate-400 whitespace-nowrap">{formatRelativeTime(s.createdAt)}</td>
                    <td class="px-6 py-3">
                      <div class="flex items-center gap-2.5 min-w-0">
                        {#if s.isClan}
                          <span class="inline-block w-3 h-3 rounded-full shrink-0" style="background-color: {s.clanColor || '#e2e8f0'};"></span>
                          <span class="font-bold text-slate-700 dark:text-slate-200 truncate">{s.displayName}</span>
                          <span class="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 shrink-0">{m.clan_public_clan_badge()}</span>
                        {:else}
                          {#if s.avatarUrl}
                            <img src={s.avatarUrl} alt={s.displayName} class="w-6 h-6 rounded-full border border-slate-200/50 dark:border-slate-800 shrink-0" />
                          {:else}
                            <div class="w-6 h-6 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-[9px] font-bold text-slate-500 uppercase shrink-0">{s.displayName.slice(0, 2)}</div>
                          {/if}
                          <span class="font-semibold text-orange-500 dark:text-orange-400 truncate">{s.displayName}</span>
                        {/if}
                      </div>
                    </td>
                    <td class="px-6 py-3">
                      {#if s.source === 'ADMIN'}
                        <span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-500 border border-violet-500/20">{m.clan_public_admin_badge()}</span>
                      {:else if s.source === 'BOOST'}
                        <span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-pink-500/10 text-pink-500 border border-pink-500/20">{m.clan_public_source_boost()}</span>
                      {:else if s.source === 'BET'}
                        <span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-500 border border-indigo-500/20">{m.clan_public_source_bet()}</span>
                      {:else if s.source === 'BET_TOP1'}
                        <span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-500 border border-indigo-500/20">{m.clan_public_source_bet_top1()}</span>
                      {:else if s.source === 'BET_TOP2'}
                        <span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-500 border border-indigo-500/20">{m.clan_public_source_bet_top2()}</span>
                      {:else if s.source === 'BET_TOP3'}
                        <span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-500 border border-indigo-500/20">{m.clan_public_source_bet_top3()}</span>
                      {:else if s.source === 'DEBT'}
                        <span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-500 border border-rose-500/20">{m.clan_public_source_debt()}</span>
                      {:else if s.source === 'DROP'}
                        <span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-teal-500/10 text-teal-500 border border-teal-500/20">{m.clan_public_source_drop()}</span>
                      {:else if s.source === 'RPG_BOSS'}
                        <span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-fuchsia-500/10 text-fuchsia-500 border border-fuchsia-500/20">{m.clan_public_source_rpg_boss()}</span>
                      {:else if s.source === 'RPG_MOB'}
                        <span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-fuchsia-500/10 text-fuchsia-500 border border-fuchsia-500/20">{m.clan_public_source_rpg_mob()}</span>
                      {:else if s.source === 'RPG_QUEST'}
                        <span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-fuchsia-500/10 text-fuchsia-500 border border-fuchsia-500/20">{m.clan_public_source_rpg_quest()}</span>
                      {:else if s.source === 'RPG_RAID'}
                        <span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-fuchsia-500/10 text-fuchsia-500 border border-fuchsia-500/20">{m.clan_public_source_rpg_raid()}</span>
                      {:else if s.source === 'RPG_ITEM'}
                        <span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-fuchsia-500/10 text-fuchsia-500 border border-fuchsia-500/20">{m.clan_public_source_rpg_item()}</span>
                      {:else if s.source === 'RPG'}
                        <!-- Gains enregistres avant la separation des trois origines. -->
                        <span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-fuchsia-500/10 text-fuchsia-500 border border-fuchsia-500/20">{m.clan_public_source_rpg()}</span>
                      {:else if s.source === 'DAILY_ALGO'}
                        <!-- Ambre : ni le violet, ni le rose, ni le bleu ciel ne sont pris,
                             et l'orange sert déjà aux pseudos dans ce même tableau. -->
                        <span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-500 border border-amber-500/20">{m.clan_public_source_daily_algo()}</span>
                      {:else}
                        <span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-500 border border-sky-500/20">{m.clan_public_source_xp()}</span>
                      {/if}
                    </td>
                    <td class="px-6 py-3 text-right whitespace-nowrap">
                      <span class="font-black tracking-tight {s.amount > 0 ? 'text-emerald-600 dark:text-emerald-400' : s.amount < 0 ? 'text-red-500' : 'text-slate-400 dark:text-slate-500'}">
                        {s.amount > 0 ? '+' : ''}{s.amount.toLocaleString(dateLocale())}
                      </span>
                      {#if s.credit > 0}
                        <span class="block text-[10px] text-slate-400 dark:text-slate-500 leading-snug" title={m.clan_public_credit_share_desc()}>
                          {m.clan_public_credit_share({ amount: s.credit.toLocaleString(dateLocale()) })}
                        </span>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </section>


    {/if}

  </div>
</div>

<style>
  /* Styles pour isoler le style du tableau blanc épuré */
  .whiteboard-container {
    background-color: #faf9f6;
    background-image:
      radial-gradient(#cbd5e1 1.2px, transparent 1.2px);
    background-size: 24px 24px;
    color: #0f172a;
    font-family: 'Outfit', sans-serif;
    transition: background-color 0.3s ease, color 0.3s ease;
  }

  :global(.dark) .whiteboard-container {
    background-color: #090d16 !important;
    background-image: radial-gradient(#1e293b 1.2px, transparent 1.2px) !important;
    color: #f8fafc !important;
  }

  .clean-card {
    background-color: #ffffff;
    border: 1px solid #e2e8f0;
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.02), 0 2px 4px -2px rgba(0, 0, 0, 0.02);
  }
  :global(.dark) .clean-card {
    background-color: #111a2e !important;
    border-color: #1e293b !important;
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.15), 0 2px 4px -2px rgba(0, 0, 0, 0.15) !important;
  }

  .tape-accent {
    position: absolute;
    top: -8px;
    right: 24px;
    width: 80px;
    height: 20px;
    background-color: rgba(251, 191, 36, 0.22);
    border-left: 1px dashed rgba(0,0,0,0.1);
    border-right: 1px dashed rgba(0,0,0,0.1);
    transform: rotate(3deg);
    z-index: 10;
  }
  :global(.dark) .tape-accent {
    background-color: rgba(251, 191, 36, 0.1) !important;
    border-left: 1px dashed rgba(255,255,255,0.08) !important;
    border-right: 1px dashed rgba(255,255,255,0.08) !important;
  }

  ::-webkit-scrollbar {
    width: 6px;
  }
  ::-webkit-scrollbar-track {
    background: #f1f5f9;
    border-radius: 4px;
  }
  :global(.dark) ::-webkit-scrollbar-track {
    background: #0c1322;
  }
  ::-webkit-scrollbar-thumb {
    background: #cbd5e1;
    border-radius: 4px;
  }
  :global(.dark) ::-webkit-scrollbar-thumb {
    background: #1e293b;
  }
  ::-webkit-scrollbar-thumb:hover {
    background: #94a3b8;
  }
  :global(.dark) ::-webkit-scrollbar-thumb:hover {
    background: #334155;
  }
</style>
