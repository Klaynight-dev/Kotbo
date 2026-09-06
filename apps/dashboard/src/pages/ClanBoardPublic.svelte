<script lang="ts">
  /**
   * Page publique unifiee des clans : classement de saison, RPG, paris et dettes.
   *
   * Elle fusionne ce que `LevelingClanPublic` et `RpgClanPublic` montraient
   * separement. Les deux endpoints restent distincts et sont appeles en
   * parallele : chacun a son cache de trente secondes et son propre interrupteur
   * de serveur, et l'un doit pouvoir tomber sans emporter l'autre.
   *
   * Aucune garde globale, donc : chaque bloc a la sienne. `clansEnabled` eteint
   * le classement, les paris et les dettes - ils viennent tous du meme payload -
   * mais laisse le classement des aventuriers, qui fonctionne encore. L'ecran
   * vide n'apparait que si les deux racines sont coupees.
   */
  import { onMount } from 'svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import {
    fetchPublicClans,
    fetchPublicRpgClans,
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
  let clansEnabled = $state(false);
  let currentClanSeason = $state(1);
  let seasonStartsAt = $state<string | null>(null);
  let seasonEndsAt = $state<string | null>(null);

  interface Participant {
    userId: string;
    clanId?: string;
    /** `null` : trouve par la recherche, mais aucun point marque cette saison. */
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
    credit: number;
    source: string;
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

  let debts = $state<PublicClanDebts | null>(null);
  let betsEnabled = $state(false);
  let recentBets = $state<PublicBetHistoryEntry[]>([]);
  let bettors = $state<PublicBettorStanding[]>([]);
  let bettorRewards = $state<PublicBettorRewards | null>(null);

  // `fetchPublic*` avale ses erreurs et rend `null` : sans ces deux drapeaux, un
  // serveur injoignable serait presente comme un serveur dont les modules sont
  // eteints, et enverrait chercher un reglage la ou il n'y a qu'une panne.
  let clansReachable = $state(true);
  let rpgReachable = $state(true);

  let rpgEnabled = $state(false);
  let rpgClans = $state<any[]>([]);
  let teamQuests = $state<any[]>([]);
  let raid = $state<any>(null);
  /** Bilan du dernier raid, servi par l'API pendant les 24 h qui suivent sa cloture. */
  let raidRecap = $state<any>(null);
  let solo = $state<any>(null);

  type Tab = 'raid' | 'ranking' | 'bets' | 'debts' | 'solo';
  let activeTab = $state<Tab>('ranking');

  /** Onglets reellement ouverts, dans l'ordre d'affichage. */
  const openTabs = $derived.by(() => {
    const tabs: Tab[] = [];
    // Le bilan passe devant tant qu'il dure : c'est une nouvelle, elle se perime, et
    // l'onglet s'en va avec elle. Il n'est pas selectionne d'office pour autant, la page
    // se consultant d'abord pour le classement de saison.
    if (raidRecap) tabs.push('raid');
    if (clansEnabled && clans.length > 0) tabs.push('ranking');
    if (clansEnabled && betsEnabled) tabs.push('bets');
    if (clansEnabled && debts) tabs.push('debts');
    if (rpgEnabled) tabs.push('solo');
    return tabs;
  });

  // Un administrateur peut couper une fonctionnalite entre deux rafraichissements :
  // rester sur un onglet devenu vide afficherait une section morte.
  $effect(() => {
    if (openTabs.length > 0 && !openTabs.includes(activeTab)) activeTab = openTabs[0];
  });

  function clanDebtOwed(clanId: string): number {
    const clan = debts?.clans.find((entry) => entry.id === clanId);
    if (!clan) return 0;
    return Math.max(0, clan.totalDebt - clan.totalEngaged);
  }

  const currentLocale = getLocale();
  function switchLocale(loc: Locale) {
    if (loc === currentLocale) return;
    userPrefs.set('language', loc);
  }

  async function loadClans(initial = false) {
    try {
      const res = await fetchPublicClans(serverId);
      clansReachable = res !== null;
      if (res) {
        clansEnabled = res.enabled ?? false;
        if (res.guildName) guildName = res.guildName;
        if (res.guildIcon) guildIcon = res.guildIcon;
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
      }
    } catch (err: any) {
      if (!initial) return;
      console.error(err);
      errorMsg = err.message || m.clan_public_error_loading();
    }
  }

  // Le RPG ne fait jamais echouer la page : quand son endpoint tombe, les cartes
  // de clan perdent leurs barres et gardent tout le reste.
  async function loadRpg() {
    try {
      const res = await fetchPublicRpgClans(serverId);
      rpgReachable = res !== null;
      if (!res) return;
      rpgEnabled = res.enabled === true;
      if (!guildIcon && res.guildIcon) guildIcon = res.guildIcon;
      if (guildName === 'Kotbo Server' && res.guildName) guildName = res.guildName;
      rpgClans = res.clans ?? [];
      teamQuests = res.quests ?? [];
      raid = res.raid ?? null;
      raidRecap = res.raidRecap ?? null;
      solo = res.solo ?? null;
    } catch (err) {
      console.error(err);
    }
  }

  async function loadAll(initial = false) {
    await Promise.all([loadClans(initial), loadRpg()]);
    if (initial) loading = false;
  }

  onMount(() => {
    void loadAll(true);
    // Le serveur ne sert ces pages qu'avec un cache de trente secondes : les
    // rappeler plus souvent ne rendrait rien de neuf.
    const refresher = setInterval(() => { void loadAll(); }, 30_000);
    return () => clearInterval(refresher);
  });

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
    return searchResult.participants.filter((p: Participant) => p.clanId === clan.id);
  }

  function getHiddenCount(clan: ClanData, shown: number): number {
    if (!searchActive) return 0;
    return Math.max(0, (searchResult.matchCounts[clan.id] ?? shown) - shown);
  }

  // Un seul rang, celui de la saison : le classement officiel est celui qui a des
  // recompenses. L'avancement RPG se lit dans la carte, il n'ouvre pas un second
  // classement qui contredirait le premier.
  const rankedClans = $derived([...clans].sort((a, b) => b.totalXp - a.totalXp));

  const rpgById = $derived(new Map(rpgClans.map((entry: any) => [entry.id, entry])));
  const questById = $derived(new Map(teamQuests.map((quest: any) => [quest.id, quest])));

  // Un raid livre en guildes RPG n'oppose pas les clans : afficher une barre de vie
  // par clan y promettrait un affrontement qu'aucun d'eux ne peut engager.
  const raidIsClanWide = $derived(raid?.teamMode === 'CLAN');
  const showClanRaidBar = $derived(raid?.status === 'OPEN' && raidIsClanWide);

  /**
   * Vie cumulee du boss sur l'ensemble des clans.
   *
   * C'est la seule chose que le ruban puisse dire et qu'aucune carte ne dit :
   * chacune ne montre que son propre clan. Un raid livre en guildes RPG n'a pas
   * d'instance par clan, la barre n'y aurait rien a additionner.
   */
  const raidAggregate = $derived.by(() => {
    if (!showClanRaidBar) return null;

    // Un clan qui n'a pas encore frappe n'a pas de ligne d'equipe : l'API rend
    // alors `raid: null`. Le compter pour rien ferait remonter la barre chaque
    // fois qu'un clan s'engage, puisque son boss entier rejoindrait d'un coup
    // les deux termes du rapport. Il compte donc pour un boss intact.
    let engagedRemaining = 0;
    let engaged = 0;
    let pool = 0;
    for (const entry of rpgClans) {
      if (!entry.raid) continue;
      engaged += 1;
      pool = Math.max(pool, entry.raid.total);
      engagedRemaining += entry.raid.defeated ? 0 : entry.raid.remaining;
    }
    if (engaged === 0 || pool <= 0) return null;

    // Tous les clans affrontent le meme boss, donc la meme reserve de points de
    // vie : celle d'une equipe engagee vaut pour celles qui ne le sont pas
    // encore.
    const total = pool * rpgClans.length;
    const remaining = engagedRemaining + pool * (rpgClans.length - engaged);
    return { remaining, total, engaged, width: percent(remaining, total) };
  });

  // Le compte a rebours ne rougit que dans la derniere heure : une alerte
  // permanente n'alerte plus de rien.
  const RAID_URGENT_MS = 3_600_000;
  let now = $state(Date.now());
  const raidUrgent = $derived(
    raid?.status === 'OPEN' && raid.closesAt
      ? new Date(raid.closesAt).getTime() - now <= RAID_URGENT_MS
      : false,
  );

  const bossesDown = $derived(
    rpgClans.filter((entry: any) => entry.raid?.defeated).length,
  );
  const clansEngaged = $derived(
    rpgClans.filter((entry: any) => {
      const raidPart = entry.raid ? (entry.raid.defeated || entry.raid.remaining < entry.raid.total) : false;
      const questPart = (entry.quests ?? []).some((q: any) => q.current > 0);
      return raidPart || questPart;
    }).length,
  );

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
   * Aventuriers affiches.
   *
   * Filtrage local, contrairement au reste de la page : la recherche du serveur
   * ne connait que les donnees de clan. L'API ne rend de toute facon que les
   * vingt premiers du classement solo, donc chercher plus loin n'aurait rien a
   * fouiller.
   */
  const displayedSoloPlayers = $derived.by(() => {
    const players = solo?.leaderboard ?? [];
    if (!searchActive) return players;
    const q = normalize(searchQuery);
    return players.filter((player: any) =>
      normalize(player.displayName).includes(q) || String(player.userId).includes(searchQuery.trim())
    );
  });

  const displayedBettors = $derived(searchActive ? searchResult.bettors : bettors);
  const showBettorRewards = $derived(!searchActive && bettorRewards !== null);
  const displayedBets = $derived(searchActive ? searchResult.bets : recentBets);

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

  function betNetGain(bet: PublicBetHistoryEntry): number {
    return (bet.winners ?? []).reduce((sum, entry) => sum + entry.netGain, 0);
  }

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

  const debtAverage = $derived(
    debtTotals.count > 0 ? Math.round(debtTotals.owed / debtTotals.count) : 0,
  );

  const debtSearchEmpty = $derived(
    searchActive && displayedDebtClans.length === 0 && displayedUnaffiliated.length === 0,
  );

  const betSearchEmpty = $derived(
    searchActive && displayedBettors.length === 0 && displayedBets.length === 0,
  );

  function formatRelativeTime(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const sec = Math.max(0, Math.floor((nowCoarse - then) / 1000));
    if (sec < 60) return m.clan_public_just_now();
    const min = Math.floor(sec / 60);
    if (min < 60) return m.clan_public_minutes_ago({ n: min });
    const hours = Math.floor(min / 60);
    if (hours < 24) return m.clan_public_hours_ago({ n: hours });
    const days = Math.floor(hours / 24);
    if (days < 30) return m.clan_public_days_ago({ n: days });
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

  // Deux horloges plutot qu'une. Le raid se compte a la seconde, mais faire
  // dependre les temps relatifs et la saison du meme tic redessinerait toute la
  // liste des derniers scores chaque seconde pour des libelles qui ne changent
  // qu'a la minute.
  let nowCoarse = $state(Date.now());

  $effect(() => {
    const interval = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(interval);
  });

  // La bascule de saison est faite par un cron cote bot (toutes les 15 min) :
  // sans resynchronisation, la page resterait figee sur « Saison terminee » et
  // sur l'ancien classement jusqu'a un rechargement manuel. Le drapeau evite de
  // redemander le classement a chaque tic une fois l'echeance passee ; il se
  // rearme des que la saison suivante a une fin dans le futur.
  let seasonResynced = false;
  $effect(() => {
    const interval = setInterval(() => {
      nowCoarse = Date.now();
      if (!seasonEndsAt) return;
      if (nowCoarse < new Date(seasonEndsAt).getTime()) {
        seasonResynced = false;
        return;
      }
      if (seasonResynced) return;
      seasonResynced = true;
      void loadClans();
    }, 60_000);
    return () => clearInterval(interval);
  });

  const seasonCountdown = $derived.by(() => {
    if (seasonStartsAt) {
      const start = new Date(seasonStartsAt).getTime();
      if (!Number.isNaN(start) && start > nowCoarse) {
        return {
          text: m.clan_public_season_starts_in({ n: Math.ceil((start - nowCoarse) / 86_400_000) }),
          ended: false,
        };
      }
    }
    if (!seasonEndsAt) return null;
    const end = new Date(seasonEndsAt).getTime();
    if (Number.isNaN(end)) return null;
    const diff = end - nowCoarse;
    if (diff <= 0) return { text: m.clan_public_season_ended(), ended: true };
    const days = Math.floor(diff / 86_400_000);
    if (days >= 1) return { text: m.clan_public_season_days_left({ n: days }), ended: false };
    const hours = Math.floor(diff / 3_600_000);
    const minutes = Math.floor((diff % 3_600_000) / 60_000);
    return { text: m.clan_public_season_hours_left({ h: hours, min: minutes }), ended: false };
  });

  /** Duree restante en clair, ou une echeance passee quand le compte est ecoule. */
  function countdown(target: string | Date | null | undefined): string {
    if (!target) return '';
    const ms = new Date(target).getTime() - now;
    if (ms <= 0) return m.rpg_public_now();

    const totalMinutes = Math.floor(ms / 60_000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    const seconds = Math.floor((ms % 60_000) / 1000);

    if (days > 0) return m.rpg_public_countdown_days({ days, hours });
    if (hours > 0) return m.rpg_public_countdown_hours({ hours, minutes });
    return m.rpg_public_countdown_minutes({ minutes, seconds });
  }

  function percent(current: number, target: number): number {
    if (target <= 0) return 0;
    return Math.min(100, Math.max(0, (current / target) * 100));
  }

  const QUEST_OBJECTIVES: Record<string, () => string> = {
    MONSTER_KILLS: m.eco_quest_obj_monsters,
    BOSS_KILLS: m.eco_quest_obj_bosses,
    RAID_ASSAULTS: m.eco_quest_obj_raid_assaults,
    RAID_DAMAGE: m.eco_quest_obj_raid_damage,
    ITEMS_LOOTED: m.eco_quest_obj_items,
    FISH_CAUGHT: m.eco_quest_obj_fish,
  };

  function objectiveLabel(objective: string): string {
    return QUEST_OBJECTIVES[objective]?.() ?? objective;
  }

  /**
   * Icone d'une quete, deduite de son objectif.
   *
   * L'emoji de la fiche est la forme Discord, seule qu'un embed sache rendre ; le
   * web a ses icones, et les faire dependre de l'objectif plutot que de la fiche
   * evite un champ que l'administrateur devrait remplir deux fois.
   */
  const QUEST_ICONS: Record<string, string> = {
    MONSTER_KILLS: 'Ghost',
    BOSS_KILLS: 'Crown',
    RAID_ASSAULTS: 'AlertTriangle',
    RAID_DAMAGE: 'Sparkles',
    ITEMS_LOOTED: 'Archive',
    FISH_CAUGHT: 'Cutlery',
  };

  function questIcon(objective: string): string {
    return QUEST_ICONS[objective] ?? 'Tasks';
  }

  function getRankBadgeColor(rank: number | null) {
    if (rank === null) return 'bg-slate-100 dark:bg-slate-800 text-slate-400';
    if (rank === 1) return 'bg-amber-500/10 text-amber-500 border border-amber-500/20';
    if (rank === 2) return 'bg-slate-400/10 text-slate-400 border border-slate-400/20';
    if (rank === 3) return 'bg-amber-700/10 text-amber-700 border border-amber-700/20';
    return 'bg-slate-100 dark:bg-slate-800 text-slate-500';
  }

  // Replis : le detail reste sur la page, il ne prend la place qu'a la demande.
  let openQuests = $state<Record<string, boolean>>({});
  let openMembers = $state<Record<string, boolean>>({});
  let openDebtors = $state<Record<string, boolean>>({});
  let raidOpen = $state(false);

  function toggle(map: Record<string, boolean>, key: string) {
    map[key] = !map[key];
  }
</script>

<svelte:head>
  <title>{m.clan_board_page_title({ guildName })}</title>
  <meta name="description" content={m.clan_public_meta_desc({ guildName })} />
</svelte:head>

<div class="min-h-screen whiteboard-container relative overflow-x-hidden py-12 px-4 sm:px-6 z-10">
  <div class="relative z-10 w-full max-w-6xl mx-auto space-y-8 animate-in fade-in duration-300">

    <header class="relative flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 p-5 rounded-lg shadow-sm">
      <div class="tape-accent"></div>

      <div class="flex items-center gap-4">
        {#if guildIcon}
          <img src={guildIcon} alt="" class="w-11 h-11 rounded-lg object-cover border border-slate-200 dark:border-slate-800 shrink-0" />
        {:else}
          <div class="w-11 h-11 bg-slate-50 dark:bg-[#0c1322] border border-slate-200 dark:border-slate-800 rounded-lg flex items-center justify-center font-bold text-sm text-slate-800 dark:text-slate-100 shrink-0">
            {guildName.slice(0, 2).toUpperCase()}
          </div>
        {/if}

        <div>
          <h1 class="text-lg font-extrabold tracking-tight text-slate-800 dark:text-slate-100">{guildName}</h1>
          {#if clansEnabled}
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
          {:else if rpgEnabled}
            <div class="flex items-center gap-1.5 text-slate-500 dark:text-slate-400 font-semibold text-xs uppercase tracking-wider">
              <span class="text-fuchsia-500"><Papicon icon="Sparkles" size={14} /></span>
              <span>{m.rpg_public_title()}</span>
            </div>
          {/if}
        </div>
      </div>

      <div class="flex items-center gap-3 self-start sm:self-auto">
        <div class="flex items-center rounded-full border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0c1322] p-0.5 text-[10px] font-bold uppercase tracking-wider">
          {#each locales as loc}
            <button
              type="button"
              onclick={() => switchLocale(loc)}
              class="px-2.5 py-1 rounded-full transition-colors cursor-pointer {loc === currentLocale
                ? 'bg-white dark:bg-[#111a2e] text-slate-800 dark:text-slate-100 shadow-sm'
                : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'}"
            >{loc}</button>
          {/each}
        </div>

        <button
          type="button"
          onclick={themeStore.toggle}
          aria-label="theme"
          class="w-8 h-8 rounded-full border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0c1322] flex items-center justify-center text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100 transition-colors cursor-pointer"
        >
          {#if themeStore.dark}
            <Papicon icon="sun" size={15} class="text-amber-500" />
          {:else}
            <Papicon icon="moon" size={15} />
          {/if}
        </button>

        <div class="relative flex items-center gap-2 px-3 py-1.5 rounded-full border border-emerald-500/20 dark:border-emerald-500/10 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400 text-xs font-bold">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span>
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 absolute"></span>
          <span class="ml-2.5 uppercase tracking-wider text-[10px]">{m.clan_public_live_badge()}</span>
        </div>
      </div>
    </header>

    {#if loading}
      <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
        <Skeleton height="500px" radius="1.25rem" />
        <Skeleton height="500px" radius="1.25rem" />
      </div>
    {:else if errorMsg}
      <div class="bg-white dark:bg-[#111a2e] border border-red-200 dark:border-red-950 p-12 rounded-lg text-center space-y-4 shadow-sm">
        <div class="w-12 h-12 bg-red-50 dark:bg-red-950/35 rounded-full flex items-center justify-center text-red-500 dark:text-red-400 mx-auto">
          <Papicon icon="AlertTriangle" size={20} />
        </div>
        <div class="space-y-1.5">
          <p class="text-slate-800 dark:text-slate-100 font-extrabold text-lg">{m.clan_public_error_title()}</p>
          <p class="text-slate-500 dark:text-slate-400 text-sm max-w-md mx-auto">{errorMsg}</p>
        </div>
      </div>
    {:else if !clansReachable && !rpgReachable}
      <!-- Les deux endpoints muets : c'est une panne, pas un reglage. -->
      <div class="bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 p-16 rounded-lg text-center flex flex-col items-center space-y-4 shadow-sm">
        <div class="w-14 h-14 rounded-full bg-slate-50 dark:bg-[#0c1322] flex items-center justify-center text-slate-400">
          <Papicon icon="AlertTriangle" size={24} />
        </div>
        <p class="text-slate-500 dark:text-slate-400 text-sm leading-relaxed max-w-sm">{m.rpg_public_unavailable()}</p>
      </div>
    {:else if openTabs.length === 0}
      <!-- Les deux racines coupees : ni clans, ni RPG. Un module eteint et un
           serveur injoignable ne sont pas la meme chose, mais ici les deux
           endpoints ont repondu - il n'y a simplement rien d'ouvert. -->
      <div class="bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 p-16 rounded-lg text-center flex flex-col items-center space-y-4 shadow-sm">
        <div class="w-14 h-14 rounded-full bg-slate-50 dark:bg-[#0c1322] flex items-center justify-center text-slate-400">
          <Papicon icon="Lock" size={24} />
        </div>
        <div class="space-y-1.5 max-w-sm">
          <h2 class="text-xl font-bold text-slate-800 dark:text-slate-100">{m.clan_board_empty_title()}</h2>
          <p class="text-slate-500 dark:text-slate-400 text-sm leading-relaxed">{m.clan_board_empty_desc()}</p>
        </div>
      </div>
    {:else}

      {#if rpgEnabled && raid}
        <!-- Ruban de raid : le seul bloc de la page qui porte une echeance, donc le
             seul a s'annoncer comme un evenement plutot qu'une donnee. -->
        <section class="raid-hud relative rounded-[5px] mx-1">
          <span class="raid-bracket tl"></span><span class="raid-bracket tr"></span>
          <span class="raid-bracket bl"></span><span class="raid-bracket br"></span>

          <button
            type="button"
            onclick={() => raidOpen = !raidOpen}
            aria-expanded={raidOpen}
            class="raid-head w-full text-left flex items-center gap-3.5 flex-wrap px-5 py-3.5 cursor-pointer"
          >
            <span class="w-[34px] h-[34px] rounded-[10px] shrink-0 grid place-items-center bg-rose-500/20 text-rose-300">
              <Papicon icon="Crown" size={17} />
            </span>

            <span class="min-w-0">
              {#if raid.status === 'OPEN' || raid.status === 'SCHEDULED'}
                <span class="block font-extrabold text-[15.5px] text-slate-50 tracking-tight">{raid.bossName}</span>
                <span class="block text-[11.5px] text-slate-400">
                  {#if raid.status === 'OPEN'}
                    {raidIsClanWide ? m.rpg_public_raid_open({ level: raid.bossLevel }) : m.rpg_public_raid_guild_mode({ level: raid.bossLevel })}
                  {:else}
                    {m.rpg_public_raid_scheduled({ level: raid.bossLevel })}
                  {/if}
                </span>
              {:else}
                <span class="block font-extrabold text-[15.5px] text-slate-50 tracking-tight">{m.rpg_public_raid_none_title()}</span>
                <span class="block text-[11.5px] text-slate-400">{m.rpg_public_raid_none()}</span>
              {/if}
            </span>

            <span class="ml-auto flex items-center gap-2.5">
              {#if raid.status === 'OPEN' || raid.status === 'SCHEDULED'}
                <span class="font-mono font-bold text-[13.5px] tabular-nums whitespace-nowrap {raidUrgent ? 'text-[#ff5a67]' : 'text-rose-300'}">
                  {raid.status === 'OPEN'
                    ? m.rpg_public_raid_closes({ time: countdown(raid.closesAt) })
                    : m.rpg_public_raid_opens({ time: countdown(raid.opensAt) })}
                </span>
              {/if}
              <span class="text-slate-500 transition-transform duration-200 {raidOpen ? 'rotate-180' : ''}">
                <Papicon icon="ChevronDown" size={16} />
              </span>
            </span>
          </button>

          {#if raidAggregate}
            <div class="raid-hp" title={`${raidAggregate.remaining.toLocaleString(dateLocale())} / ${raidAggregate.total.toLocaleString(dateLocale())} - ${m.rpg_public_summary({ engaged: raidAggregate.engaged, total: rpgClans.length })}`}>
              <div style="width: {raidAggregate.width}%"></div>
            </div>
          {/if}

          {#if raidOpen}
            <div class="px-5 pb-4 pt-3.5 border-t border-white/10 space-y-3">
              <div class="flex flex-wrap gap-6">
                {#if raid.status === 'OPEN' && raidIsClanWide}
                  <div>
                    <span class="block text-[10px] uppercase tracking-[0.14em] font-bold text-slate-500">{m.rpg_public_clans_title()}</span>
                    <b class="font-mono text-[16px] text-slate-100">{m.rpg_public_summary({ engaged: clansEngaged, total: rpgClans.length })}</b>
                  </div>
                  {#if bossesDown > 0}
                    <div>
                      <span class="block text-[10px] uppercase tracking-[0.14em] font-bold text-slate-500">{m.rpg_public_raid_bar()}</span>
                      <b class="font-mono text-[16px] text-emerald-300">{m.rpg_public_summary_bosses({ count: bossesDown })}</b>
                    </div>
                  {/if}
                {/if}
                {#if raid.status === 'OPEN'}
                  <div>
                    <span class="block text-[10px] uppercase tracking-[0.14em] font-bold text-slate-500">{m.clan_public_col_date()}</span>
                    <b class="font-mono text-[16px] text-slate-100">{new Date(raid.opensAt).toLocaleString(dateLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</b>
                  </div>
                {/if}
              </div>
              <p class="text-[12px] text-slate-400 leading-relaxed border-l-2 border-[#d9b45a] pl-3">
                {raidIsClanWide ? m.rpg_public_raid_open({ level: raid.bossLevel }) : m.rpg_public_raid_guild_mode({ level: raid.bossLevel })}
              </p>
            </div>
          {/if}
        </section>
      {/if}

      {#if clansEnabled || rpgEnabled || openTabs.length > 1}
        <!-- Onglets et recherche sur une seule ligne, bord a bord avec le
             contenu : trois largeurs differentes empilees donnaient un escalier. -->
        <div class="flex flex-wrap items-center gap-3 relative z-10">
          {#if openTabs.length > 1}
            <div class="flex flex-wrap gap-2">
              {#each openTabs as tab}
                <button
                  type="button"
                  onclick={() => activeTab = tab}
                  class="px-5 py-2.5 rounded-lg text-xs font-bold uppercase tracking-widest transition-all cursor-pointer border {activeTab === tab
                    ? (tab === 'bets' ? 'bg-indigo-500/10 border-indigo-500/40 text-indigo-600 dark:text-indigo-400'
                      : tab === 'debts' ? 'bg-rose-500/10 border-rose-500/40 text-rose-600 dark:text-rose-400'
                      : tab === 'solo' ? 'bg-fuchsia-500/10 border-fuchsia-500/40 text-fuchsia-600 dark:text-fuchsia-400'
                      : tab === 'raid' ? 'bg-red-500/10 border-red-500/40 text-red-600 dark:text-red-400'
                      : 'bg-amber-500/10 border-amber-500/40 text-amber-600 dark:text-amber-400')
                    : 'bg-white dark:bg-[#111a2e] border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}"
                >
                  {#if tab === 'raid'}{m.clan_board_tab_raid()}
                  {:else if tab === 'ranking'}{m.clan_public_tab_ranking()}
                  {:else if tab === 'bets'}{m.clan_public_tab_bets()}
                  {:else if tab === 'debts'}{m.clan_public_tab_debts()}
                  {:else}{m.clan_board_tab_solo()}{/if}
                </button>
              {/each}
            </div>
          {/if}

          {#if clansEnabled || rpgEnabled}
            <div class="relative flex-1 min-w-[220px] group">
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
                  class="absolute right-3.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-slate-200 dark:bg-slate-750 hover:bg-red-100 dark:hover:bg-red-950/45 text-slate-500 dark:text-slate-400 flex items-center justify-center text-[11px] font-bold transition-all cursor-pointer"
                >✕</button>
              {/if}
            </div>
          {/if}
        </div>
      {/if}

      {#if activeTab === 'ranking'}
        <!-- Classement et derniers scores cote a cote : les deux sont visibles des
             l'arrivee, sans defilement. -->
        <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,1.62fr)_minmax(0,1fr)] gap-6 items-stretch relative z-10">

          <div class="space-y-5 min-w-0 self-start">
            {#each rankedClans as clan, index (clan.id)}
              {@const pList = getDisplayedParticipants(clan).slice(0, MEMBER_DISPLAY_LIMIT)}
              {@const hiddenCount = getHiddenCount(clan, pList.length)}
              {@const debtOwed = clanDebtOwed(clan.id)}
              {@const rpg = rpgById.get(clan.id)}

              <!-- Le scotch vit hors de l'article : celui-ci rogne ce qui depasse
                   pour garder ses angles arrondis sous les panneaux replies, et
                   rognait donc aussi le morceau qui doit deborder en haut. -->
              <div class="relative">
                <div class="tape-accent"></div>
                <article class="clean-card bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm overflow-hidden">
                <div class="flex items-center gap-3 flex-wrap px-5 pt-4 pb-3">
                  <span class="w-[26px] h-[26px] rounded-lg shrink-0 grid place-items-center font-mono text-xs font-bold {index === 0 ? 'bg-amber-500/10 text-amber-500' : 'bg-slate-100 dark:bg-slate-800 text-slate-500'}">{index + 1}</span>
                  <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background: {clan.roleColor || '#94a3b8'}"></span>
                  <div class="min-w-0">
                    <h2 class="text-base font-extrabold text-slate-800 dark:text-slate-100 tracking-tight truncate">{clan.name}</h2>
                    <p class="text-[11.5px] text-slate-400 dark:text-slate-500">{m.clan_public_member_count({ n: clan.memberCount })}</p>
                  </div>
                  <div class="ml-auto text-right">
                    <span class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">{m.clan_public_season_xp_label()}</span>
                    <b class="font-mono text-[17px] font-bold text-slate-800 dark:text-slate-100 tabular-nums">{clan.totalXp.toLocaleString(dateLocale())}</b>
                    {#if debtOwed > 0}
                      <span
                        class="block font-mono text-[10px] font-semibold text-rose-500 mt-0.5"
                        title={m.clan_public_credit_badge_hint()}
                      >{m.clan_public_credit_badge({ amount: debtOwed.toLocaleString(dateLocale()) })}</span>
                    {/if}
                  </div>
                </div>

                {#if rpg && (showClanRaidBar || (rpg.quests ?? []).length > 0)}
                  <div class="px-5 pb-3.5 space-y-3">
                    {#if showClanRaidBar}
                      <div class="space-y-1.5">
                        <div class="flex flex-wrap items-baseline gap-2 text-[12.5px]">
                          <span class="font-semibold text-slate-700 dark:text-slate-200 inline-flex items-center gap-1.5">
                            <span class="{rpg.raid?.defeated ? 'text-emerald-500' : 'text-rose-500'}"><Papicon icon="Crown" size={12} /></span>
                            {raid.bossName}
                          </span>
                          <span class="ml-auto font-mono text-[11.5px] text-slate-500 dark:text-slate-400 tabular-nums">
                            {#if !rpg.raid}
                              {m.rpg_public_raid_not_engaged()}
                            {:else if rpg.raid.defeated}
                              <span class="text-emerald-500 font-semibold">{m.rpg_public_raid_defeated()}</span>
                            {:else}
                              {rpg.raid.remaining.toLocaleString(dateLocale())} / {rpg.raid.total.toLocaleString(dateLocale())}
                            {/if}
                          </span>
                        </div>
                        <div class="h-[7px] rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                          <!-- La barre montre les points de vie restants du boss, pas
                               l'avancement : une barre qui se vide se lit comme un boss
                               qui tombe. -->
                          <div
                            class="h-full rounded-full transition-all duration-500 {rpg.raid?.defeated ? 'bg-emerald-500' : 'bg-rose-500'}"
                            style="width: {rpg.raid ? (rpg.raid.defeated ? 100 : percent(rpg.raid.remaining, rpg.raid.total)) : 0}%"
                          ></div>
                        </div>
                      </div>
                    {/if}

                    {#each rpg.quests ?? [] as progress (progress.questId)}
                      {@const quest = questById.get(progress.questId)}
                      {#if quest}
                        {@const key = `${clan.id}:${progress.questId}`}
                        <div class="space-y-1.5">
                          <div class="flex flex-wrap items-baseline gap-2 text-[12.5px]">
                            <span class="font-semibold text-slate-700 dark:text-slate-200 inline-flex items-center gap-1.5 min-w-0">
                              <span class="text-slate-400"><Papicon icon={questIcon(quest.objective)} size={12} /></span>
                              <span class="truncate">{quest.name}</span>
                              <button
                                type="button"
                                onclick={() => toggle(openQuests, key)}
                                aria-expanded={openQuests[key] === true}
                                aria-label={m.clan_board_quest_detail()}
                                class="w-[15px] h-[15px] shrink-0 rounded-full grid place-items-center text-[10px] font-bold leading-none bg-slate-100 dark:bg-slate-800 text-slate-500 hover:bg-sky-500/10 hover:text-sky-500 transition-colors cursor-pointer"
                              >i</button>
                            </span>
                            <span class="ml-auto font-mono text-[11.5px] text-slate-500 dark:text-slate-400 tabular-nums whitespace-nowrap">
                              {progress.current.toLocaleString(dateLocale())} / {progress.target.toLocaleString(dateLocale())}
                              {#if progress.completed}<span class="text-emerald-500 font-semibold ml-1">{m.rpg_public_quest_done()}</span>{/if}
                            </span>
                          </div>
                          <div class="h-[7px] rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                            <div
                              class="h-full rounded-full transition-all duration-500 {progress.completed ? 'bg-emerald-500' : 'bg-sky-500'}"
                              style="width: {percent(progress.current, progress.target)}%"
                            ></div>
                          </div>
                          {#if openQuests[key]}
                            <div class="mt-1.5 px-3 py-2.5 rounded-lg bg-slate-50 dark:bg-[#0c1322] border border-slate-100 dark:border-slate-800 text-[11.5px] text-slate-600 dark:text-slate-300 leading-relaxed">
                              {quest.description}
                              <span class="block mt-1 font-mono text-[10.5px] text-slate-400 dark:text-slate-500">
                                {m.eco_quest_goal({ target: quest.target, objective: objectiveLabel(quest.objective), hours: quest.windowHours })}
                                &middot; {m.rpg_public_quest_resets({ time: countdown(quest.windowEndsAt) })}
                              </span>
                            </div>
                          {/if}
                        </div>
                      {/if}
                    {/each}
                  </div>
                {/if}

                <div class="flex flex-wrap gap-2 px-5 pb-4">
                  <button
                    type="button"
                    onclick={() => toggle(openMembers, clan.id)}
                    aria-expanded={openMembers[clan.id] === true}
                    class="px-2.5 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider bg-slate-50 dark:bg-[#0c1322] border border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition-colors cursor-pointer inline-flex items-center gap-1.5"
                  >
                    {m.clan_board_fold_members()}
                    <span class="font-mono opacity-70">{clan.memberCount}</span>
                  </button>
                  {#if debts}
                    <button
                      type="button"
                      onclick={() => toggle(openDebtors, clan.id)}
                      aria-expanded={openDebtors[clan.id] === true}
                      disabled={debtOwed === 0}
                      class="px-2.5 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider bg-slate-50 dark:bg-[#0c1322] border border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 transition-colors inline-flex items-center gap-1.5 {debtOwed === 0 ? 'opacity-50 cursor-default' : 'hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer'}"
                    >
                      {#if debtOwed === 0}
                        {m.clan_board_fold_no_debt()}
                      {:else}
                        {m.clan_public_tab_debts()}
                        <span class="font-mono opacity-70">{debtOwed.toLocaleString(dateLocale())}</span>
                      {/if}
                    </button>
                  {/if}
                </div>

                {#if openMembers[clan.id]}
                  <div class="border-t border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-[#0c1322]">
                    {#if searching && pList.length === 0}
                      <p class="px-5 py-4 text-xs text-slate-400 italic">{m.clan_public_searching()}</p>
                    {:else if pList.length === 0}
                      <p class="px-5 py-4 text-xs text-slate-400 italic">{m.clan_public_no_members_found()}</p>
                    {:else}
                      {#each pList as p (p.userId)}
                        <div class="flex items-center gap-2.5 px-5 py-2 border-b border-slate-100 dark:border-slate-800 last:border-0">
                          <span class="w-6 h-6 shrink-0 rounded-md grid place-items-center text-[10px] font-mono font-bold {getRankBadgeColor(p.rank)}">{p.rank ?? '-'}</span>
                          {#if p.avatarUrl}
                            <img src={p.avatarUrl} alt="" class="w-6 h-6 rounded-full shrink-0" />
                          {:else}
                            <span class="w-6 h-6 rounded-full bg-slate-200 dark:bg-slate-800 shrink-0"></span>
                          {/if}
                          <span class="text-[13px] font-medium text-slate-700 dark:text-slate-200 truncate">{p.displayName}</span>
                          <span class="ml-auto font-mono text-xs text-slate-500 dark:text-slate-400 tabular-nums shrink-0">
                            {#if p.rank === null}
                              <span class="text-slate-400 dark:text-slate-500 italic font-sans text-[11px]">{m.clan_public_no_points_yet()}</span>
                            {:else}
                              {p.xp.toLocaleString(dateLocale())}
                            {/if}
                          </span>
                        </div>
                      {/each}
                      {#if hiddenCount > 0}
                        <p class="px-5 py-2 text-[11px] text-slate-400 italic">{m.clan_public_more_results({ n: hiddenCount })}</p>
                      {/if}
                    {/if}
                  </div>
                {/if}

                {#if openDebtors[clan.id] && debts}
                  {@const clanDebt = debts.clans.find((entry) => entry.id === clan.id)}
                  <div class="border-t border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-[#0c1322]">
                    {#each clanDebt?.debtors ?? [] as debtor (debtor.userId)}
                      <div class="flex items-center gap-2.5 px-5 py-2 border-b border-slate-100 dark:border-slate-800 last:border-0">
                        {#if debtor.avatarUrl}
                          <img src={debtor.avatarUrl} alt="" class="w-6 h-6 rounded-full shrink-0" />
                        {:else}
                          <span class="w-6 h-6 rounded-full bg-slate-200 dark:bg-slate-800 shrink-0"></span>
                        {/if}
                        <span class="text-[13px] font-medium text-slate-700 dark:text-slate-200 truncate">{debtor.displayName}</span>
                        <span class="ml-auto font-mono text-xs text-rose-500 tabular-nums shrink-0">
                          -{debtor.amount.toLocaleString(dateLocale())}
                          {#if debtor.engaged > 0}
                            <span class="block text-[10px] text-slate-400 dark:text-slate-500 font-sans">{m.clan_public_debt_engaged_hint({ amount: debtor.engaged.toLocaleString(dateLocale()) })}</span>
                          {/if}
                        </span>
                      </div>
                    {/each}
                  </div>
                {/if}
                </article>
              </div>
            {:else}
              <p class="text-sm text-slate-500 dark:text-slate-400 italic">{m.rpg_public_no_clan()}</p>
            {/each}
          </div>

          <!--
            Elle epouse la hauteur de la colonne des clans plutot que de
            s'arreter en cours de route. Le retrait du flux normal est ce qui
            le permet : l'API rend vingt derniers scores, assez pour depasser
            deux ou trois clans et tirer toute la ligne vers le bas. Hors
            colonnes, la carte reprend sa hauteur naturelle.
          -->
          <div class="min-w-0 lg:relative lg:h-full">
          <section class="clean-card bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm overflow-hidden flex flex-col min-h-0 lg:absolute lg:inset-0">
            <div class="px-5 py-3.5 border-b border-slate-100 dark:border-slate-800">
              <h2 class="text-xs font-black uppercase tracking-widest text-slate-700 dark:text-slate-200 flex items-center gap-2">
                <Papicon icon="Activity" size={14} />
                {m.clan_public_recent_scores_title()}
              </h2>
              <p class="text-[11px] text-slate-400 dark:text-slate-500 mt-1">{m.clan_public_recent_scores_desc()}</p>
            </div>

            {#if displayedScores.length === 0}
              <p class="flex-1 grid place-items-center px-5 py-8 text-center text-sm text-slate-400 italic">{m.clan_public_no_recent_scores()}</p>
            {:else}
              <div class="flex-1 min-h-0 overflow-y-auto">
                {#each displayedScores as s (s.id)}
                  <div class="flex items-start gap-2.5 px-5 py-2.5 border-b border-slate-100 dark:border-slate-800 last:border-0">
                    <div class="min-w-0 flex-1 space-y-1">
                      <div class="flex items-center gap-2 text-[13px] font-semibold text-slate-700 dark:text-slate-200">
                        {#if s.isClan}
                          <span class="w-2 h-2 rounded-full shrink-0" style="background: {s.clanColor || '#94a3b8'}"></span>
                          <span class="truncate">{s.clanName ?? s.displayName}</span>
                          <span class="text-[9px] font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 shrink-0">{m.clan_public_clan_badge()}</span>
                        {:else}
                          {#if s.avatarUrl}
                            <img src={s.avatarUrl} alt="" class="w-5 h-5 rounded-full shrink-0" />
                          {:else}
                            <span class="w-5 h-5 rounded-full bg-slate-200 dark:bg-slate-800 shrink-0"></span>
                          {/if}
                          <span class="truncate">{s.displayName}</span>
                        {/if}

                        {#if s.source === 'ADMIN'}
                          <span class="text-[9px] font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-500 shrink-0">{m.clan_public_admin_badge()}</span>
                        {:else if s.source === 'BOOST'}
                          <span class="text-[9px] font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-pink-500/10 text-pink-500 shrink-0">{m.clan_public_source_boost()}</span>
                        {:else if s.source === 'BET'}
                          <span class="text-[9px] font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-500 shrink-0">{m.clan_public_source_bet()}</span>
                        {:else if s.source === 'BET_TOP1'}
                          <span class="text-[9px] font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-500 shrink-0">{m.clan_public_source_bet_top1()}</span>
                        {:else if s.source === 'BET_TOP2'}
                          <span class="text-[9px] font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-500 shrink-0">{m.clan_public_source_bet_top2()}</span>
                        {:else if s.source === 'BET_TOP3'}
                          <span class="text-[9px] font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-500 shrink-0">{m.clan_public_source_bet_top3()}</span>
                        {:else if s.source === 'DEBT'}
                          <span class="text-[9px] font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-500 shrink-0">{m.clan_public_source_debt()}</span>
                        {:else if s.source === 'DROP'}
                          <span class="text-[9px] font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-teal-500/10 text-teal-500 shrink-0">{m.clan_public_source_drop()}</span>
                        {:else if s.source === 'RPG_BOSS'}
                          <span class="text-[9px] font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-fuchsia-500/10 text-fuchsia-500 shrink-0">{m.clan_public_source_rpg_boss()}</span>
                        {:else if s.source === 'RPG_MOB'}
                          <span class="text-[9px] font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-fuchsia-500/10 text-fuchsia-500 shrink-0">{m.clan_public_source_rpg_mob()}</span>
                        {:else if s.source === 'RPG_QUEST'}
                          <span class="text-[9px] font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-fuchsia-500/10 text-fuchsia-500 shrink-0">{m.clan_public_source_rpg_quest()}</span>
                        {:else if s.source === 'RPG_RAID'}
                          <span class="text-[9px] font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-fuchsia-500/10 text-fuchsia-500 shrink-0">{m.clan_public_source_rpg_raid()}</span>
                        {:else if s.source === 'RPG_ITEM'}
                          <span class="text-[9px] font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-fuchsia-500/10 text-fuchsia-500 shrink-0">{m.clan_public_source_rpg_item()}</span>
                        {:else if s.source === 'RPG'}
                          <!-- Gains enregistres avant la separation des trois origines. -->
                          <span class="text-[9px] font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-fuchsia-500/10 text-fuchsia-500 shrink-0">{m.clan_public_source_rpg()}</span>
                        {:else if s.source === 'DAILY_ALGO'}
                          <span class="text-[9px] font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500 shrink-0">{m.clan_public_source_daily_algo()}</span>
                        {:else}
                          <span class="text-[9px] font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-500 shrink-0">{m.clan_public_source_xp()}</span>
                        {/if}
                      </div>
                      <div class="font-mono text-[10px] text-slate-400 dark:text-slate-500">
                        {formatRelativeTime(s.createdAt)}
                        {#if !s.isClan && s.clanName}&middot; {s.clanName}{/if}
                      </div>
                    </div>
                    <div class="font-mono text-[13.5px] font-bold text-right shrink-0 tabular-nums {s.amount < 0 ? 'text-rose-500' : 'text-emerald-500'}">
                      {s.amount > 0 ? '+' : ''}{s.amount.toLocaleString(dateLocale())}
                      {#if s.credit > 0}
                        <span class="block text-[9.5px] font-sans font-medium text-slate-400 dark:text-slate-500" title={m.clan_public_credit_share_desc()}>
                          {m.clan_public_credit_share({ amount: s.credit.toLocaleString(dateLocale()) })}
                        </span>
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </section>
          </div>
        </div>

      {:else if activeTab === 'bets'}
        {#if searching}
          <p class="text-center text-sm text-slate-400 italic py-8">{m.clan_public_searching()}</p>
        {:else if betSearchEmpty}
          <p class="text-center text-sm text-slate-400 italic py-8">{m.clan_public_search_no_match()}</p>
        {:else if displayedBettors.length === 0 && displayedBets.length === 0}
          <p class="text-center text-sm text-slate-400 italic py-8">{m.clan_public_bets_empty()}</p>
        {:else}
          <div class="space-y-6 relative z-10">
            {#if displayedBettors.length > 0}
              <div class="relative">
                <div class="tape-accent"></div>
                <section class="clean-card bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm overflow-hidden">
                <div class="px-6 py-4 border-b border-slate-100 dark:border-slate-800">
                  <h2 class="text-sm font-black uppercase tracking-widest text-slate-700 dark:text-slate-200 flex items-center gap-2">
                    <Papicon icon="Trophy" size={14} />
                    {m.clan_public_bettors_title()}
                  </h2>
                  <p class="text-[11px] text-slate-400 dark:text-slate-500 mt-1">{m.clan_public_bettors_desc()}</p>
                  {#if showBettorRewards && bettorRewards}
                    <p class="text-[11px] text-slate-400 dark:text-slate-500 mt-1.5 flex flex-wrap gap-x-2">
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
                  <table class="w-full text-sm">
                    <thead>
                      <tr class="text-[9.5px] font-mono font-semibold uppercase tracking-[0.12em] text-slate-400 border-b border-slate-100 dark:border-slate-800">
                        <th class="px-6 py-3 text-left">{m.clan_public_col_user()}</th>
                        <th class="px-6 py-3 text-center">{m.clan_public_bettors_col_record()}</th>
                        <th class="px-6 py-3 text-center">{m.clan_public_bettors_col_streak()}</th>
                        <th class="px-6 py-3 text-right">{m.clan_public_bettors_col_net()}</th>
                        {#if showBettorRewards}
                          <th class="px-6 py-3 text-right">{m.clan_public_bettors_col_reward()}</th>
                        {/if}
                      </tr>
                    </thead>
                    <tbody>
                      {#each displayedBettors as bettor (bettor.userId)}
                        <tr class="border-b border-slate-100 dark:border-slate-800 last:border-0">
                          <td class="px-6 py-3">
                            <div class="flex items-center gap-2.5">
                              {#if bettor.avatarUrl}
                                <img src={bettor.avatarUrl} alt="" class="w-6 h-6 rounded-full shrink-0" />
                              {:else}
                                <span class="w-6 h-6 rounded-full bg-slate-200 dark:bg-slate-800 shrink-0"></span>
                              {/if}
                              <span class="font-semibold text-slate-700 dark:text-slate-200 truncate">{bettor.displayName}</span>
                            </div>
                          </td>
                          <td class="px-6 py-3 text-center font-mono text-slate-600 dark:text-slate-300 tabular-nums">{bettor.wins} - {bettor.losses}</td>
                          <td class="px-6 py-3 text-center">
                            {#if bettor.bestStreak > 1}
                              <span class="font-mono text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500 font-bold">{m.clan_public_bettors_streak({ n: bettor.bestStreak })}</span>
                            {:else}
                              <span class="font-mono text-slate-400">{bettor.bestStreak}</span>
                            {/if}
                          </td>
                          <td class="px-6 py-3 text-right font-mono tabular-nums font-semibold {bettor.netGain < 0 ? 'text-rose-500' : 'text-emerald-500'}">
                            {bettor.netGain > 0 ? '+' : ''}{bettor.netGain.toLocaleString(dateLocale())}
                          </td>
                          {#if showBettorRewards}
                            <td class="px-6 py-3 text-right">
                              <!-- Seules les marches reellement occupees portent une prime. -->
                              {#if bettor.reward > 0}
                                <span class="font-mono text-[11px] font-bold text-amber-500">
                                  {#if bettor.podiumRank === 1 && bettorRewards?.roleName}
                                    <span
                                      class="mr-1"
                                      style={bettorRewards.roleColor ? `color: ${bettorRewards.roleColor}` : ''}
                                    >{m.clan_public_bettors_top1()}</span>
                                  {/if}
                                  {m.clan_public_bettors_reward_amount({ amount: bettor.reward.toLocaleString(dateLocale()) })}
                                </span>
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
              </div>
            {/if}

            {#if displayedBets.length > 0}
              <section class="clean-card bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm overflow-hidden">
                <div class="px-6 py-4 border-b border-slate-100 dark:border-slate-800">
                  <h2 class="text-sm font-black uppercase tracking-widest text-slate-700 dark:text-slate-200 flex items-center gap-2">
                    <Papicon icon="Sparkles" size={14} />
                    {m.clan_public_bets_title()}
                  </h2>
                  <p class="text-[11px] text-slate-400 dark:text-slate-500 mt-1">{m.clan_public_bets_desc()}</p>
                </div>
                {#each displayedBets as bet (bet.id)}
                  <div class="px-6 py-3.5 border-b border-slate-100 dark:border-slate-800 last:border-0 space-y-1">
                    <p class="text-[13.5px] font-semibold text-slate-700 dark:text-slate-200">{bet.subject}</p>
                    <p class="text-[11.5px] text-slate-500 dark:text-slate-400">
                      {formatRelativeTime(bet.resolvedAt)}
                      {#if bet.winningSideLabel}
                        &middot; <span class="text-emerald-500 font-semibold">{bet.winningSideLabel}</span>
                      {/if}
                      &middot; {betSideLabel(bet.winners)}
                      &middot; <span class="font-mono">+{betNetGain(bet).toLocaleString(dateLocale())}</span>
                    </p>
                    {#if bet.creditUsed > 0}
                      <p class="text-[11px] text-rose-500 font-mono">{m.clan_public_bets_on_credit({ amount: bet.creditUsed.toLocaleString(dateLocale()) })}</p>
                    {/if}
                  </div>
                {/each}
              </section>
            {/if}
          </div>
        {/if}

      {:else if activeTab === 'debts'}
        <div class="space-y-6 relative z-10">
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div class="clean-card bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm px-5 py-4">
              <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{m.clan_public_debt_total_label()}</p>
              <b class="block font-mono text-[22px] font-bold text-rose-500 tabular-nums mt-0.5">{debtTotals.owed.toLocaleString(dateLocale())}</b>
              {#if debtTotals.engaged > 0}
                <p class="text-[10px] text-slate-400 dark:text-slate-500 mt-1 leading-snug" title={m.clan_public_debt_engaged_desc()}>
                  {m.clan_public_debt_engaged_hint({ amount: debtTotals.engaged.toLocaleString(dateLocale()) })}
                </p>
              {/if}
            </div>
            <div class="clean-card bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm px-5 py-4">
              <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{m.clan_public_debt_people_label()}</p>
              <b class="block font-mono text-[22px] font-bold text-slate-800 dark:text-slate-100 tabular-nums mt-0.5">{debtTotals.count}</b>
              {#if debtTotals.partial}
                <p class="text-[10px] text-slate-400 dark:text-slate-500 mt-1 leading-snug">{m.clan_public_debt_search_scope()}</p>
              {/if}
            </div>
            <div class="clean-card bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm px-5 py-4">
              <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{m.clan_public_debt_average_label()}</p>
              <b class="block font-mono text-[22px] font-bold text-slate-800 dark:text-slate-100 tabular-nums mt-0.5">{debtAverage.toLocaleString(dateLocale())}</b>
              <p class="text-[10px] text-slate-400 dark:text-slate-500 mt-1 leading-snug">{m.clan_public_debt_average_hint()}</p>
            </div>
          </div>

          {#if searching}
            <p class="text-center text-sm text-slate-400 italic py-8">{m.clan_public_searching()}</p>
          {:else if debtSearchEmpty}
            <p class="text-center text-sm text-slate-400 italic py-8">{m.clan_public_search_no_match()}</p>
          {:else if displayedDebtClans.length === 0 && displayedUnaffiliated.length === 0}
            <p class="text-center text-sm text-slate-400 italic py-8">{m.clan_public_debt_empty()}</p>
          {:else}
            <div class="grid grid-cols-1 md:grid-cols-2 gap-5 items-start">
              {#each displayedDebtClans as clan (clan.id)}
                <section class="clean-card bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm overflow-hidden">
                  <div class="px-5 py-3.5 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2.5">
                    <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background: {clan.roleColor || '#94a3b8'}"></span>
                    <div class="min-w-0">
                      <h2 class="text-base font-extrabold text-slate-800 dark:text-slate-100 truncate">{clan.name}</h2>
                      <p class="text-[11px] text-slate-400">{m.clan_public_debt_debtors({ n: clan.debtorCount })}</p>
                    </div>
                    <div class="ml-auto text-right">
                      <span class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">{m.clan_public_debt_clan_total()}</span>
                      <b class="font-mono text-[15px] text-rose-500 tabular-nums">{clan.totalDebt.toLocaleString(dateLocale())}</b>
                      {#if clan.totalEngaged > 0}
                        <span class="block text-[10px] text-slate-400 dark:text-slate-500">{m.clan_public_debt_engaged_hint({ amount: clan.totalEngaged.toLocaleString(dateLocale()) })}</span>
                      {/if}
                    </div>
                  </div>
                  {#if clan.debtors.length === 0}
                    <p class="px-5 py-4 text-xs text-slate-400 italic">{m.clan_public_debt_clan_clear()}</p>
                  {:else}
                    {#each clan.debtors as debtor (debtor.userId)}
                      <div class="flex items-center gap-2.5 px-5 py-2 border-b border-slate-100 dark:border-slate-800 last:border-0">
                        {#if debtor.avatarUrl}
                          <img src={debtor.avatarUrl} alt="" class="w-6 h-6 rounded-full shrink-0" />
                        {:else}
                          <span class="w-6 h-6 rounded-full bg-slate-200 dark:bg-slate-800 shrink-0"></span>
                        {/if}
                        <span class="text-[13px] font-medium text-slate-700 dark:text-slate-200 truncate">{debtor.displayName}</span>
                        <span class="ml-auto font-mono text-xs text-rose-500 tabular-nums shrink-0 text-right">
                          -{debtor.amount.toLocaleString(dateLocale())}
                          {#if debtor.engaged > 0}
                            <span class="block text-[10px] text-slate-400 dark:text-slate-500 font-sans">{m.clan_public_debt_engaged_hint({ amount: debtor.engaged.toLocaleString(dateLocale()) })}</span>
                          {/if}
                        </span>
                      </div>
                    {/each}
                    {#if clan.debtorCount > clan.debtors.length}
                      <p class="px-5 py-2 text-[11px] text-slate-400 italic">{m.clan_public_more_results({ n: clan.debtorCount - clan.debtors.length })}</p>
                    {/if}
                  {/if}
                </section>
              {/each}

              {#if displayedUnaffiliated.length > 0}
                <section class="clean-card bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm overflow-hidden">
                  <div class="px-5 py-3.5 border-b border-slate-100 dark:border-slate-800">
                    <h2 class="text-sm font-black uppercase tracking-widest text-slate-700 dark:text-slate-200">{m.clan_public_debt_unaffiliated_title()}</h2>
                    <p class="text-[11px] text-slate-400 dark:text-slate-500 mt-1">{m.clan_public_debt_unaffiliated_desc()}</p>
                  </div>
                  {#each displayedUnaffiliated as debtor (debtor.userId)}
                    <div class="flex items-center gap-2.5 px-5 py-2 border-b border-slate-100 dark:border-slate-800 last:border-0">
                      {#if debtor.avatarUrl}
                        <img src={debtor.avatarUrl} alt="" class="w-6 h-6 rounded-full shrink-0" />
                      {:else}
                        <span class="w-6 h-6 rounded-full bg-slate-200 dark:bg-slate-800 shrink-0"></span>
                      {/if}
                      <span class="text-[13px] font-medium text-slate-700 dark:text-slate-200 truncate">{debtor.displayName}</span>
                      <span class="ml-auto font-mono text-xs text-rose-500 tabular-nums shrink-0 text-right">
                        -{debtor.amount.toLocaleString(dateLocale())}
                        {#if debtor.engaged > 0}
                          <span class="block text-[10px] text-slate-400 dark:text-slate-500 font-sans">{m.clan_public_debt_engaged_hint({ amount: debtor.engaged.toLocaleString(dateLocale()) })}</span>
                        {/if}
                      </span>
                    </div>
                  {/each}
                </section>
              {/if}
            </div>
          {/if}
        </div>

      {:else if activeTab === 'raid'}
        <!-- Bilan du dernier raid. L'onglet n'existe que tant que l'API le sert, donc
             `raidRecap` est forcement renseigne ici. -->
        <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-6 items-start relative z-10">
          <section class="clean-card bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm overflow-hidden">
            <div class="px-5 py-3.5 border-b border-slate-100 dark:border-slate-800">
              <h2 class="text-sm font-black uppercase tracking-widest text-slate-700 dark:text-slate-200 flex items-center gap-2">
                <Papicon icon="Crown" size={14} class="text-red-400" />
                {raidRecap.bossEmoji} {raidRecap.bossName}
              </h2>
              <p class="text-[11px] text-slate-400 dark:text-slate-500 mt-1">
                {m.clan_board_raid_ended({
                  level: raidRecap.bossLevel,
                  date: new Date(raidRecap.resolvedAt).toLocaleString(dateLocale()),
                })}
              </p>
            </div>
            {#each raidRecap.teams as team}
              <div class="flex items-center gap-3 px-5 py-2.5 border-b border-slate-100 dark:border-slate-800 last:border-0">
                {#if team.defeated}
                  <Papicon icon="Trophy" size={14} class="text-emerald-500 shrink-0" />
                {:else}
                  <Papicon icon="Shield" size={14} class="text-slate-400 shrink-0" />
                {/if}
                <span class="text-[13px] font-semibold text-slate-700 dark:text-slate-200 truncate flex-1">{team.teamName}</span>
                <span class="text-[11px] text-slate-400 dark:text-slate-500 shrink-0 tabular-nums">
                  {team.defeated
                    ? m.clan_board_raid_downed()
                    : m.clan_board_raid_survived({ remaining: team.remainingHealth.toLocaleString(dateLocale()) })}
                </span>
              </div>
            {:else}
              <p class="px-5 py-8 text-center text-sm text-slate-400 italic">{m.clan_board_raid_no_team()}</p>
            {/each}
          </section>

          {#if raidRecap.strikers.length > 0}
            <section class="clean-card bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm overflow-hidden">
              <div class="px-5 py-3.5 border-b border-slate-100 dark:border-slate-800">
                <h2 class="text-sm font-black uppercase tracking-widest text-slate-700 dark:text-slate-200 flex items-center gap-2">
                  <Papicon icon="Grades" size={14} />
                  {m.clan_board_raid_strikers()}
                </h2>
              </div>
              {#each raidRecap.strikers as striker, index (striker.userId)}
                <div class="flex items-center gap-3 px-5 py-2.5 border-b border-slate-100 dark:border-slate-800 last:border-0">
                  <span class="w-7 font-mono text-[13px] font-bold text-slate-400 tabular-nums shrink-0">{index + 1}</span>
                  {#if striker.avatarUrl}
                    <img src={striker.avatarUrl} alt="" class="w-8 h-8 rounded-full shrink-0" />
                  {:else}
                    <span class="w-8 h-8 rounded-full bg-slate-200 dark:bg-slate-800 shrink-0"></span>
                  {/if}
                  <span class="text-[13px] font-semibold text-slate-700 dark:text-slate-200 truncate flex-1">{striker.displayName}</span>
                  <span class="text-[11px] text-slate-400 dark:text-slate-500 shrink-0 tabular-nums">
                    {m.clan_board_raid_damage({
                      damage: striker.damage.toLocaleString(dateLocale()),
                      assaults: striker.assaults,
                    })}
                  </span>
                </div>
              {/each}
            </section>
          {/if}
        </div>

      {:else}
        <!-- Aventuriers : classement personnel du RPG. Il ne compte pas pour les
             clans, mais il dit qui joue - et c'est tout ce qui reste quand le
             module de clans est eteint. -->
        <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-6 items-start relative z-10">
          <section class="clean-card bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm overflow-hidden">
            <div class="px-5 py-3.5 border-b border-slate-100 dark:border-slate-800">
              <h2 class="text-sm font-black uppercase tracking-widest text-slate-700 dark:text-slate-200 flex items-center gap-2">
                <Papicon icon="Grades" size={14} />
                {m.rpg_public_solo_title()}
              </h2>
            </div>
            {#if displayedSoloPlayers.length === 0}
              <p class="px-5 py-8 text-center text-sm text-slate-400 italic">
                {searchActive ? m.clan_public_search_no_match() : m.rpg_public_solo_empty()}
              </p>
            {:else}
              {#each displayedSoloPlayers as player (player.userId)}
                <div class="flex items-center gap-3 px-5 py-2.5 border-b border-slate-100 dark:border-slate-800 last:border-0">
                  <span class="w-7 font-mono text-[13px] font-bold text-slate-400 tabular-nums shrink-0">{player.rank}</span>
                  {#if player.avatarUrl}
                    <img src={player.avatarUrl} alt="" class="w-8 h-8 rounded-full shrink-0" />
                  {:else}
                    <span class="w-8 h-8 rounded-full bg-slate-200 dark:bg-slate-800 shrink-0"></span>
                  {/if}
                  <span class="text-[13px] font-semibold text-slate-700 dark:text-slate-200 truncate flex-1">{player.displayName}</span>
                  <span class="text-[11px] text-slate-400 dark:text-slate-500 shrink-0">
                    {m.rpg_public_solo_line({
                      level: player.level,
                      monsters: player.monstersKilled,
                      bosses: player.bossesKilled,
                    })}
                  </span>
                </div>
              {/each}
            {/if}
          </section>

          {#if (solo?.quests ?? []).length > 0}
            <section class="clean-card bg-white dark:bg-[#111a2e] border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm overflow-hidden">
              <div class="px-5 py-3.5 border-b border-slate-100 dark:border-slate-800">
                <h2 class="text-sm font-black uppercase tracking-widest text-slate-700 dark:text-slate-200 flex items-center gap-2">
                  <Papicon icon="Tasks" size={14} />
                  {m.rpg_public_solo_quests()}
                </h2>
              </div>
              {#each solo.quests as quest (quest.id)}
                <div class="px-5 py-3.5 border-b border-slate-100 dark:border-slate-800 last:border-0 space-y-1">
                  <div class="flex flex-wrap items-baseline gap-2">
                    <span class="text-[13px] font-semibold text-slate-700 dark:text-slate-200 inline-flex items-center gap-1.5">
                      <span class="text-slate-400"><Papicon icon={questIcon(quest.objective)} size={13} /></span>
                      {quest.name}
                    </span>
                    <span class="ml-auto font-mono text-[10.5px] text-slate-400">{m.rpg_public_quest_resets({ time: countdown(quest.windowEndsAt) })}</span>
                  </div>
                  <p class="text-[11.5px] text-slate-500 dark:text-slate-400 leading-relaxed">{quest.description}</p>
                  <p class="font-mono text-[10.5px] text-slate-400 dark:text-slate-500">
                    {m.eco_quest_goal({ target: quest.target, objective: objectiveLabel(quest.objective), hours: quest.windowHours })}
                  </p>
                </div>
              {/each}
            </section>
          {/if}
        </div>
      {/if}

      <footer class="flex items-center justify-center gap-1.5 text-[11px] text-slate-400 dark:text-slate-500 pt-2">
        <Papicon icon="Clock" size={12} />
        {m.rpg_public_refresh()}
      </footer>
    {/if}

  </div>
</div>

<style>
  .whiteboard-container {
    background-color: #faf9f6;
    background-image: radial-gradient(#cbd5e1 1.2px, transparent 1.2px);
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

  /*
   * `dark:selection:bg-slate-850` ne designait aucune couleur : slate ne va pas
   * au-dela de 900. La regle sombre ne s'appliquait donc jamais, et la
   * selection restait sur le jaune pale du theme clair - illisible sous le
   * texte clair du theme sombre. Les deux couples fond/texte sont poses ici.
   */
  .whiteboard-container :global(::selection) {
    background: #fde68a;
    color: #0f172a;
  }
  :global(.dark) .whiteboard-container :global(::selection) {
    background: rgba(251, 191, 36, 0.32);
    color: #f8fafc;
  }

  .clean-card {
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.02), 0 2px 4px -2px rgba(0, 0, 0, 0.02);
  }
  :global(.dark) .clean-card {
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.15), 0 2px 4px -2px rgba(0, 0, 0, 0.15) !important;
  }

  .tape-accent {
    position: absolute;
    top: -8px;
    right: 24px;
    width: 80px;
    height: 20px;
    background-color: rgba(251, 191, 36, 0.22);
    border-left: 1px dashed rgba(0, 0, 0, 0.1);
    border-right: 1px dashed rgba(0, 0, 0, 0.1);
    transform: rotate(3deg);
    z-index: 10;
  }
  :global(.dark) .tape-accent {
    background-color: rgba(251, 191, 36, 0.1) !important;
    border-left: 1px dashed rgba(255, 255, 255, 0.08) !important;
    border-right: 1px dashed rgba(255, 255, 255, 0.08) !important;
  }

  /*
   * Ruban de raid : seul bloc sombre dans les deux themes, et seul a angles vifs
   * sur une page de cartes arrondies. C'est le signal qu'il ne se lit pas comme
   * une donnee mais comme un evenement en cours.
   */
  .raid-hud {
    background: #0b0d12;
    border: 1px solid #000;
    outline: 3px solid #3b3d38;
    box-shadow: 0 10px 24px -12px rgba(0, 0, 0, 0.55);
  }

  .raid-head {
    background: linear-gradient(90deg, rgba(225, 29, 72, 0.2), transparent 58%);
  }
  .raid-head:hover {
    background: linear-gradient(90deg, rgba(225, 29, 72, 0.26), transparent 58%);
  }

  /* Vie cumulee du boss : elle se vide, elle ne se remplit pas. */
  .raid-hp {
    height: 4px;
    background: rgba(255, 255, 255, 0.07);
    overflow: hidden;
  }
  .raid-hp > div {
    height: 100%;
    background: linear-gradient(90deg, #9f1239, #f43f5e);
    transition: width 0.6s ease;
  }

  .raid-bracket {
    position: absolute;
    width: 13px;
    height: 13px;
    opacity: 0;
    pointer-events: none;
    animation: bracket-in 0.38s ease-out forwards;
  }
  .raid-bracket.tl { top: -4px; left: -4px; border-top: 2px solid #d9b45a; border-left: 2px solid #d9b45a; animation-delay: 0.05s; }
  .raid-bracket.tr { top: -4px; right: -4px; border-top: 2px solid #d9b45a; border-right: 2px solid #d9b45a; animation-delay: 0.10s; }
  .raid-bracket.bl { bottom: -4px; left: -4px; border-bottom: 2px solid #d9b45a; border-left: 2px solid #d9b45a; animation-delay: 0.15s; }
  .raid-bracket.br { bottom: -4px; right: -4px; border-bottom: 2px solid #d9b45a; border-right: 2px solid #d9b45a; animation-delay: 0.20s; }

  @keyframes bracket-in {
    from { opacity: 0; transform: scale(0.4); }
    to { opacity: 1; transform: scale(1); }
  }

  @media (prefers-reduced-motion: reduce) {
    .raid-bracket { opacity: 1; animation: none; }
    .raid-hp > div { transition: none; }
  }
</style>
