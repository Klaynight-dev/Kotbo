<script lang="ts">
  /**
   * Page publique du RPG de clan.
   *
   * Elle repond a trois questions, dans cet ordre : quand tombe le prochain boss de raid,
   * ou en est chaque clan sur celui qui court, et ou en est chacun sur les quetes d'equipe.
   * Seules les quetes adossees aux clans du serveur y figurent : celles des guildes RPG ne
   * concernent pas les clans dont la page parle.
   *
   * Les comptes a rebours sont recalcules toutes les secondes cote navigateur plutot que
   * recharges : une page laissee ouverte pendant un raid doit voir le temps passer sans
   * rappeler le serveur.
   */
  import { onMount, onDestroy } from 'svelte';
  import { m } from '../lib/i18n';
  import Papicon from '../lib/components/Papicon.svelte';
  import Skeleton from '../lib/components/Skeleton.svelte';
  import { fetchPublicRpgClans } from '../lib/api';

  const { serverId }: { serverId: string } = $props();

  let loading = $state(true);
  let data = $state<any>(null);
  let now = $state(Date.now());

  let ticker: ReturnType<typeof setInterval> | null = null;
  let refresher: ReturnType<typeof setInterval> | null = null;

  onMount(async () => {
    await load();
    ticker = setInterval(() => { now = Date.now(); }, 1000);
    // Le serveur ne sert cette page qu'avec un cache de trente secondes : la rappeler plus
    // souvent ne rendrait rien de neuf.
    refresher = setInterval(() => { void load(); }, 30_000);
  });

  onDestroy(() => {
    if (ticker) clearInterval(ticker);
    if (refresher) clearInterval(refresher);
  });

  async function load() {
    const res = await fetchPublicRpgClans(serverId);
    if (res) data = res;
    loading = false;
  }

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
   * L'emoji de la fiche est la forme Discord, seule qu'un embed sache rendre ; le web a
   * ses icones, et les faire dependre de l'objectif plutot que de la fiche evite d'ajouter
   * un champ que l'administrateur devrait remplir deux fois.
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

  const clans = $derived(data?.clans ?? []);
  const quests = $derived(data?.quests ?? []);
  const raid = $derived(data?.raid ?? null);
  const solo = $derived(data?.solo ?? null);
  const clansEnabled = $derived(data?.clansEnabled === true);

  // Sans clans, il n'y aurait qu'un boss de raid a montrer : la vue solo existe pour
  // elle-meme, et devient la seule proposee quand le module de clans est eteint.
  let mode = $state<'clans' | 'solo'>('clans');
  const effectiveMode = $derived(clansEnabled ? mode : 'solo');

  /**
   * Avancement d'un clan, de 0 a 1 par epreuve.
   *
   * Le boss compte pour une epreuve comme chaque quete : sans ca, un clan qui a abattu son
   * boss passerait derriere un clan qui a coche trois quetes faciles, alors que c'est
   * l'inverse que la page doit montrer.
   */
  function clanScore(clan: any): number {
    const raid = clan.raid
      ? (clan.raid.defeated ? 1 : 1 - clan.raid.remaining / Math.max(1, clan.raid.total))
      : 0;
    const quests = (clan.quests ?? []).reduce(
      (sum: number, quest: any) => sum + Math.min(1, quest.current / Math.max(1, quest.target)),
      0,
    );
    return raid + quests;
  }

  // Une page qui dit ou en est chaque clan se lit du plus avance au moins avance : l'ordre
  // alphabetique n'apprend rien a qui vient comparer.
  const rankedClans = $derived([...clans].sort((a: any, b: any) => clanScore(b) - clanScore(a)));

  const clansEngaged = $derived(rankedClans.filter((clan: any) => clanScore(clan) > 0).length);
  const bossesDown = $derived(rankedClans.filter((clan: any) => clan.raid?.defeated).length);

  // Un raid livre en guildes RPG n'oppose pas les clans : afficher une barre de vie par
  // clan y ferait promettre un affrontement qu'aucun d'eux ne peut engager.
  const raidIsClanWide = $derived(raid?.teamMode === 'CLAN');
</script>

<svelte:head>
  <title>{data?.guildName ? `${data.guildName} - ${m.rpg_public_title()}` : m.rpg_public_title()}</title>
</svelte:head>

<div class="min-h-screen bg-surface text-on-surface px-4 py-10 sm:px-8">
  <div class="max-w-6xl mx-auto space-y-8">
    <header class="flex items-center gap-4">
      {#if data?.guildIcon}
        <img src={data.guildIcon} alt="" class="w-14 h-14 rounded-2xl" />
      {/if}
      <div>
        <h1 class="text-2xl font-semibold font-headline">{m.rpg_public_title()}</h1>
        <p class="text-sm text-on-surface-variant/70">{data?.guildName ?? ''}</p>
      </div>
    </header>

    {#if loading}
      <Skeleton height="240px" radius="1rem" />
    {:else if !data}
      <!-- Un serveur injoignable et un module eteint ne sont pas la meme chose : les
           confondre enverrait chercher un reglage la ou il n'y a qu'une panne. -->
      <p class="text-sm text-on-surface-variant/70 bg-surface-container-high/30 border border-outline-variant/10 rounded-xl px-6 py-8 text-center">
        {m.rpg_public_unavailable()}
      </p>
    {:else if !data.enabled}
      <p class="text-sm text-on-surface-variant/70 bg-surface-container-high/30 border border-outline-variant/10 rounded-xl px-6 py-8 text-center">
        {m.rpg_public_disabled()}
      </p>
    {:else}
      <!-- Le raid en premier : c'est ce qui a une echeance, donc ce qu'on vient verifier. -->
      <section class="bg-surface-container-low/40 border border-outline-variant/10 rounded-2xl p-6 space-y-2">
        {#if raid?.status === 'OPEN'}
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <h2 class="text-lg font-semibold flex items-center gap-2">
              <Papicon icon="Crown" size={18} class="text-red-400" />
              {raid.bossName}
            </h2>
            <span class="text-[13px] font-semibold text-red-400">{m.rpg_public_raid_closes({ time: countdown(raid.closesAt) })}</span>
          </div>
          <p class="text-xs text-on-surface-variant/60">
            {raidIsClanWide ? m.rpg_public_raid_open({ level: raid.bossLevel }) : m.rpg_public_raid_guild_mode({ level: raid.bossLevel })}
          </p>
        {:else if raid?.status === 'SCHEDULED'}
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <h2 class="text-lg font-semibold flex items-center gap-2">
              <Papicon icon="Crown" size={18} class="text-primary" />
              {raid.bossName}
            </h2>
            <span class="text-[13px] font-semibold text-primary">{m.rpg_public_raid_opens({ time: countdown(raid.opensAt) })}</span>
          </div>
          <p class="text-xs text-on-surface-variant/60">{m.rpg_public_raid_scheduled({ level: raid.bossLevel })}</p>
        {:else}
          <h2 class="text-lg font-semibold">{m.rpg_public_raid_none_title()}</h2>
          <p class="text-xs text-on-surface-variant/60">{m.rpg_public_raid_none()}</p>
        {/if}
      </section>

      {#if clansEnabled}
        <div class="tab-group w-fit">
          <button onclick={() => mode = 'clans'} class="tab-button {effectiveMode === 'clans' ? 'active' : ''}">
            {m.rpg_public_mode_clans()}
          </button>
          <button onclick={() => mode = 'solo'} class="tab-button {effectiveMode === 'solo' ? 'active' : ''}">
            {m.rpg_public_mode_solo()}
          </button>
        </div>
      {/if}

      {#if effectiveMode === 'solo'}
        <section class="space-y-3">
          <h2 class="text-[11px] font-bold uppercase tracking-widest text-on-surface-variant/60 flex items-center gap-1.5">
            <Papicon icon="Grades" size={12} />
            {m.rpg_public_solo_title()}
          </h2>

          {#if (solo?.leaderboard ?? []).length === 0}
            <p class="text-sm text-on-surface-variant/60 italic">{m.rpg_public_solo_empty()}</p>
          {:else}
            <div class="bg-surface-container-low/40 border border-outline-variant/10 rounded-2xl divide-y divide-outline-variant/10 overflow-hidden">
              {#each solo.leaderboard as player (player.userId)}
                <div class="flex items-center gap-3 px-5 py-3">
                  <span class="w-7 text-[13px] font-bold text-on-surface-variant/50 tabular-nums">{player.rank}</span>
                  {#if player.avatarUrl}
                    <img src={player.avatarUrl} alt="" class="w-8 h-8 rounded-full shrink-0" />
                  {:else}
                    <span class="w-8 h-8 rounded-full bg-outline-variant/15 shrink-0"></span>
                  {/if}
                  <span class="text-[13px] font-semibold truncate flex-1">{player.displayName}</span>
                  <span class="text-[11px] text-on-surface-variant/60 shrink-0">
                    {m.rpg_public_solo_line({
                      level: player.level,
                      monsters: player.monstersKilled,
                      bosses: player.bossesKilled,
                    })}
                  </span>
                </div>
              {/each}
            </div>
          {/if}

          {#if (solo?.quests ?? []).length > 0}
            <h2 class="text-[11px] font-bold uppercase tracking-widest text-on-surface-variant/60 pt-2 flex items-center gap-1.5">
              <Papicon icon="Tasks" size={12} />
              {m.rpg_public_solo_quests()}
            </h2>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {#each solo.quests as quest (quest.id)}
                <div class="bg-surface-container-low/40 border border-outline-variant/10 rounded-xl px-5 py-4">
                  <div class="flex flex-wrap items-baseline justify-between gap-2">
                    <span class="text-[13px] font-semibold flex items-center gap-1.5">
                      <Papicon icon={questIcon(quest.objective)} size={14} class="text-on-surface-variant/70" />
                      {quest.name}
                    </span>
                    <span class="text-[11px] text-on-surface-variant/50">{m.rpg_public_quest_resets({ time: countdown(quest.windowEndsAt) })}</span>
                  </div>
                  <p class="text-[11px] text-on-surface-variant/60 mt-1 leading-relaxed">{quest.description}</p>
                  <p class="text-[11px] text-on-surface-variant/50 mt-1">
                    {m.eco_quest_goal({ target: quest.target, objective: objectiveLabel(quest.objective), hours: quest.windowHours })}
                  </p>
                </div>
              {/each}
            </div>
          {/if}
        </section>
      {:else}
      {#if quests.length > 0}
        <section class="space-y-2">
          <h2 class="text-[11px] font-bold uppercase tracking-widest text-on-surface-variant/60 flex items-center gap-1.5">
            <Papicon icon="Tasks" size={12} />
            {m.rpg_public_quests_title()}
          </h2>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {#each quests as quest (quest.id)}
              <div class="bg-surface-container-low/40 border border-outline-variant/10 rounded-xl px-5 py-4">
                <div class="flex flex-wrap items-baseline justify-between gap-2">
                  <span class="text-[13px] font-semibold flex items-center gap-1.5">
                    <Papicon icon={questIcon(quest.objective)} size={14} class="text-on-surface-variant/70" />
                    {quest.name}
                  </span>
                  <span class="text-[11px] text-on-surface-variant/50">{m.rpg_public_quest_resets({ time: countdown(quest.windowEndsAt) })}</span>
                </div>
                <p class="text-[11px] text-on-surface-variant/60 mt-1 leading-relaxed">{quest.description}</p>
                <p class="text-[11px] text-on-surface-variant/50 mt-1">
                  {m.eco_quest_goal({ target: quest.target, objective: objectiveLabel(quest.objective), hours: quest.windowHours })}
                </p>
              </div>
            {/each}
          </div>
        </section>
      {/if}

      <section class="space-y-3">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 class="text-[11px] font-bold uppercase tracking-widest text-on-surface-variant/60 flex items-center gap-1.5">
            <Papicon icon="Grades" size={12} />
            {m.rpg_public_clans_title()}
          </h2>
          {#if rankedClans.length > 0}
            <p class="text-[11px] text-on-surface-variant/50">
              {m.rpg_public_summary({ engaged: clansEngaged, total: rankedClans.length })}
              {#if raid?.status === 'OPEN' && raidIsClanWide && bossesDown > 0}
                {' · '}{m.rpg_public_summary_bosses({ count: bossesDown })}
              {/if}
            </p>
          {/if}
        </div>

        <div class="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {#each rankedClans as clan, index (clan.id)}
          <article class="bg-surface-container-low/40 border border-outline-variant/10 rounded-2xl p-5 space-y-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                <span class="text-[11px] font-bold text-on-surface-variant/40 tabular-nums w-5 shrink-0">{index + 1}</span>
                <span class="w-2.5 h-2.5 rounded-full shrink-0" style={`background:${clan.roleColor ?? 'var(--color-outline-variant)'}`}></span>
                <h3 class="text-base font-semibold truncate">{clan.name}</h3>
              </div>
              <span class="text-[11px] text-on-surface-variant/50">{m.rpg_public_members({ count: clan.memberCount })}</span>
            </div>

            {#if raid?.status === 'OPEN' && raidIsClanWide}
              <div class="space-y-1">
                <div class="flex flex-wrap items-baseline justify-between gap-2 text-[12px]">
                  <span class="font-semibold">{m.rpg_public_raid_bar()}</span>
                  <span class="text-on-surface-variant/60">
                    {#if !clan.raid}
                      {m.rpg_public_raid_not_engaged()}
                    {:else if clan.raid.defeated}
                      {m.rpg_public_raid_defeated()}
                    {:else}
                      {clan.raid.remaining.toLocaleString()} / {clan.raid.total.toLocaleString()}
                    {/if}
                  </span>
                </div>
                <div class="h-2 rounded-full bg-outline-variant/15 overflow-hidden">
                  <!-- La barre montre les points de vie restants du boss, pas l'avancement :
                       une barre qui se vide se lit comme un boss qui tombe. -->
                  <div
                    class="h-full rounded-full transition-all duration-500 {clan.raid?.defeated ? 'bg-emerald-500' : 'bg-red-500'}"
                    style={`width:${clan.raid ? (clan.raid.defeated ? 100 : percent(clan.raid.remaining, clan.raid.total)) : 0}%`}
                  ></div>
                </div>
              </div>
            {/if}

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
            {#each clan.quests ?? [] as progress (progress.questId)}
              {@const quest = quests.find((entry: any) => entry.id === progress.questId)}
              {#if quest}
                <div class="space-y-1">
                  <div class="flex flex-wrap items-baseline justify-between gap-2 text-[12px]">
                    <span class="font-semibold flex items-center gap-1.5">
                      <Papicon icon={questIcon(quest.objective)} size={12} class="text-on-surface-variant/60" />
                      {quest.name}
                    </span>
                    <span class="text-on-surface-variant/60">
                      {progress.current.toLocaleString()} / {progress.target.toLocaleString()}
                      {#if progress.completed}<span class="text-emerald-400 ml-1">{m.rpg_public_quest_done()}</span>{/if}
                    </span>
                  </div>
                  <div class="h-2 rounded-full bg-outline-variant/15 overflow-hidden">
                    <div
                      class="h-full rounded-full transition-all duration-500 {progress.completed ? 'bg-emerald-500' : 'bg-primary'}"
                      style={`width:${percent(progress.current, progress.target)}%`}
                    ></div>
                  </div>
                </div>
              {/if}
            {/each}
            </div>

            {#if quests.length === 0 && !(raid?.status === 'OPEN' && raidIsClanWide)}
              <p class="text-[11px] text-on-surface-variant/50 italic">{m.rpg_public_clan_idle()}</p>
            {/if}
          </article>
        {:else}
          <p class="text-sm text-on-surface-variant/60 italic">{m.rpg_public_no_clan()}</p>
        {/each}
        </div>
      </section>

      {/if}

      <footer class="flex items-center justify-center gap-1.5 text-[11px] text-on-surface-variant/40 pt-4">
        <Papicon icon="Clock" size={12} />
        {m.rpg_public_refresh()}
      </footer>
    {/if}
  </div>
</div>
