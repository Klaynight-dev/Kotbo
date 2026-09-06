<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { router } from 'tinro';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import UserDisplay from '../lib/components/UserDisplay.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import { subscribeRealtime } from '../lib/stores/realtime.svelte';
  import { API_BASE_URL } from '../lib/api';
  import { m } from '../lib/i18n';

  const { eventId } = $props<{ eventId: string }>();

  let event = $state<any>(null);
  let stats = $state<any>(null);
  let registrations = $state<any[]>([]);
  let unsubscribeRealtime: (() => void) | null = null;

  let activeTab = $state<'stats' | 'participants' | 'registrations'>('stats');

  const currentQuestion = $derived(event?.questions?.find((q: any) => q.id === stats?.questionId) || event?.questions?.[event?.questions?.length - 1]);
  const currentQIdx = $derived(event?.questions?.findIndex((q: any) => q.id === stats?.questionId) + 1);
  const totalQ = $derived(event?.questions?.length || 0);
  const isCustom = $derived(event?.type === 'CUSTOM');

  onMount(async () => {
    await loadEvent();
    if (event?.type === 'CUSTOM') {
      await loadRegistrations();
      activeTab = 'registrations';
      unsubscribeRealtime = subscribeRealtime({
        reasons: ['events_updated'],
        fallbackMs: 5000,
        onUpdate: () => {
          void loadRegistrations();
        },
      });
    } else {
      await loadStats();
      unsubscribeRealtime = subscribeRealtime({
        reasons: ['events_updated'],
        fallbackMs: 3000,
        onUpdate: () => {
          void loadStats();
        },
      });
    }
  });

  onDestroy(() => {
    unsubscribeRealtime?.();
  });

  async function loadEvent() {
    try {
      const guildId = authStore.selectedGuildId;
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${guildId}/events/${eventId}`, {
        headers: { 'Authorization': `Bearer ${authStore.token}` }
      });
      const data = await res.json();
      event = data.event;
    } catch (err) {
      toast.error('Erreur chargement événement');
    }
  }

  async function loadStats() {
    try {
      const guildId = authStore.selectedGuildId;
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${guildId}/events/${eventId}/stats`, {
        headers: { 'Authorization': `Bearer ${authStore.token}` }
      });
      const data = await res.json();
      stats = data.stats;
    } catch (err) {
      console.error('Stats error:', err);
    }
  }

  async function loadRegistrations() {
    try {
      const guildId = authStore.selectedGuildId;
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${guildId}/events/${eventId}/registrations`, {
        headers: { 'Authorization': `Bearer ${authStore.token}` }
      });
      const data = await res.json();
      registrations = data.registrations || [];
    } catch (err) {
      console.error('Registrations error:', err);
    }
  }

  async function removeRegistration(userId: string) {
    if (!(await confirmDialog.danger(m.evc_confirm_remove_reg_title(), '', m.evc_confirm_remove_reg_btn()))) return;
    try {
      const guildId = authStore.selectedGuildId;
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${guildId}/events/${eventId}/registrations/${userId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${authStore.token}` }
      });
      if (res.ok) {
        toast.success(m.evc_reg_removed_toast());
        await loadRegistrations();
      } else {
        toast.error('Erreur lors de la suppression');
      }
    } catch {
      toast.error('Erreur réseau');
    }
  }

  async function nextQuestion() {
    try {
      const guildId = authStore.selectedGuildId;
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${guildId}/events/${eventId}/next`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authStore.token}` }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'completed') {
          toast.success(m.evc_event_finished_toast());
          router.goto('/events');
        } else {
          toast.success(m.evc_next_question_toast());
          await loadStats();
        }
      } else {
        const data = await res.json();
        toast.error(data.error || 'Erreur');
      }
    } catch (err) {
      toast.error('Erreur réseau');
    }
  }

  async function prevQuestion() {
    try {
      const guildId = authStore.selectedGuildId;
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${guildId}/events/${eventId}/prev`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authStore.token}` }
      });
      if (res.ok) {
        toast.success(m.evc_prev_question_toast());
        await loadStats();
      } else {
        const data = await res.json();
        toast.error(data.error || 'Erreur');
      }
    } catch (err) {
      toast.error('Erreur réseau');
    }
  }

  async function finishEvent() {
    if (!(await confirmDialog.ask({ title: m.evc_confirm_finish_event(), confirmLabel: m.evc_btn_finish(), variant: 'warning' }))) return;
    try {
      const guildId = authStore.selectedGuildId;
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${guildId}/events/${eventId}/finish`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authStore.token}` }
      });
      if (res.ok) {
        toast.success(m.evc_event_finished_toast());
        router.goto('/events');
      } else {
        const data = await res.json();
        toast.error(data.error || 'Erreur');
      }
    } catch (err) {
      toast.error('Erreur réseau');
    }
  }
</script>

<ModulePage
  title={isCustom ? m.evc_custom_title() : m.evc_pilot_title()}
  description={isCustom ? m.evc_custom_desc() : m.evc_pilot_desc()}
  icon={isCustom ? 'Calendar' : 'Activity'}
  featureKey="events"
>
  {#snippet actions()}
    <div class="flex gap-3">
      <button
        onclick={() => router.goto('/events')}
        class="px-5 py-2.5 bg-surface-container-high rounded-xl font-medium text-[13px] border border-outline-variant/10 hover:bg-surface-container-highest transition-colors"
      >
        {m.evc_btn_back()}
      </button>
      {#if event && !isCustom && event.type !== 'CTF'}
        <button
          onclick={prevQuestion}
          class="px-5 py-2.5 bg-surface-container-high rounded-xl font-medium text-[13px] border border-outline-variant/10 hover:bg-surface-container-highest transition-colors flex items-center gap-2 disabled:opacity-30"
          disabled={currentQIdx <= 1}
        >
          <Papicon icon="SkipBack" size={12} /> {m.evc_btn_prev_question()}
        </button>
        <button
          onclick={nextQuestion}
          class="px-5 py-2.5 bg-emerald-500 text-white rounded-xl font-medium text-[13px] shadow-sm transition-transform flex items-center gap-2"
        >
          <Papicon icon="SkipForward" size={12} /> {currentQIdx === totalQ ? m.evc_btn_finish_quiz() : m.evc_btn_next_question()}
        </button>
      {/if}
      {#if isCustom}
        <button
          onclick={() => router.goto(`/events/edit/${eventId}`)}
          class="px-5 py-2.5 bg-surface-container-high rounded-xl font-medium text-[13px] border border-outline-variant/10 hover:bg-surface-container-highest transition-colors flex items-center gap-2"
        >
          <Papicon icon="Edit3" size={12} /> {m.evc_btn_edit()}
        </button>
      {/if}
      <button
        onclick={finishEvent}
        class="px-5 py-2.5 bg-red-500/10 text-red-500 rounded-xl font-medium text-[13px] border border-red-500/20 hover:bg-red-500/20 transition-colors"
      >
        {m.evc_btn_finish()}
      </button>
    </div>
  {/snippet}

  {#if event}
    <div class="space-y-10 pb-20">
      <section class="bg-primary/5 rounded-xl p-10 border border-primary/10">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-8">
            <div>
              <span class="text-xs font-medium text-primary">
                {isCustom ? m.evc_custom_event_badge() : m.evc_ongoing_event_badge()}
              </span>
              <h3 class="text-lg font-semibold text-on-surface mt-2">{event.title}</h3>
            </div>
            <div class="h-12 w-px bg-outline-variant/20 hidden md:block"></div>
            {#if isCustom}
              <div class="hidden md:block">
                <span class="text-xs font-medium text-on-surface-variant/40">{m.evc_col_status()}</span>
                <p class="text-2xl font-semibold mt-1 {event.status === 'PUBLISHED' ? 'text-blue-500' : event.status === 'COMPLETED' ? 'text-purple-500' : 'text-on-surface'}">
                  {event.status === 'DRAFT' ? m.ev_status_draft() : event.status === 'PUBLISHED' ? m.ev_status_published() : event.status === 'COMPLETED' ? m.ev_status_completed() : event.status === 'CANCELLED' ? m.ev_status_cancelled() : event.status}
                </p>
              </div>
              <div class="h-12 w-px bg-outline-variant/20 hidden md:block"></div>
              <div class="hidden md:block">
                <span class="text-xs font-medium text-on-surface-variant/40">{m.evc_col_form()}</span>
                <p class="text-lg font-semibold text-on-surface mt-1">{event.customForm?.name || m.evc_direct_registration()}</p>
              </div>
            {:else if event.type === 'CTF'}
              <div class="hidden md:block">
                <span class="text-xs font-medium text-on-surface-variant/40">{m.evc_col_type()}</span>
                <p class="text-2xl font-semibold text-emerald-500 mt-1">Capture The Flag</p>
              </div>
              <div class="h-12 w-px bg-outline-variant/20 hidden md:block"></div>
              <div class="hidden md:block">
                <span class="text-xs font-medium text-on-surface-variant/40">{m.evc_col_challenges()}</span>
                <p class="text-2xl font-semibold text-on-surface mt-1">{event.ctfChallenges?.length || 0}</p>
              </div>
            {:else}
              <div class="hidden md:block">
                <span class="text-xs font-medium text-on-surface-variant/40">{m.evc_col_progression()}</span>
                <p class="text-2xl font-semibold text-on-surface mt-1">{m.evc_progression_value({ current: currentQIdx || 1, total: totalQ })}</p>
              </div>
            {/if}
          </div>
          <div class="text-right">
            <span class="text-xs font-medium text-on-surface-variant/40">
              {isCustom ? m.evc_registered_count() : m.evc_participants_count()}
            </span>
            <p class="text-lg font-semibold text-on-surface mt-1">
              {isCustom ? registrations.length : (event.participants?.length || 0)}
            </p>
          </div>
        </div>
      </section>

      {#if isCustom}
        <div class="flex gap-2 bg-surface-container-low/50 p-1.5 rounded-lg w-fit border border-outline-variant/10">
          <button
            onclick={() => activeTab = 'registrations'}
            class="px-6 py-2.5 rounded-xl text-xs font-medium transition-all {activeTab === 'registrations' ? 'bg-surface-container-highest text-on-surface shadow-sm' : 'text-on-surface-variant/40 hover:text-on-surface-variant/60'}"
          >
            {m.evc_tab_registrations({ count: registrations.length })}
          </button>
        </div>
      {:else}
        <div class="flex gap-2 bg-surface-container-low/50 p-1.5 rounded-lg w-fit border border-outline-variant/10">
          <button
            onclick={() => activeTab = 'stats'}
            class="px-6 py-2.5 rounded-xl text-xs font-medium transition-all {activeTab === 'stats' ? 'bg-surface-container-highest text-on-surface shadow-sm' : 'text-on-surface-variant/40 hover:text-on-surface-variant/60'}"
          >
            {event.type === 'CTF' ? m.evc_tab_challenges() : m.evc_tab_chart()}
          </button>
          <button
            onclick={() => activeTab = 'participants'}
            class="px-6 py-2.5 rounded-xl text-xs font-medium transition-all {activeTab === 'participants' ? 'bg-surface-container-highest text-on-surface shadow-sm' : 'text-on-surface-variant/40 hover:text-on-surface-variant/60'}"
          >
            {m.evc_tab_participants()}
          </button>
        </div>
      {/if}

      {#if activeTab === 'registrations' && isCustom}
        <div class="bg-surface-container-low/30 rounded-xl border border-outline-variant/10 overflow-hidden">
          {#if registrations.length === 0}
            <div class="py-20 text-center">
              <div class="w-16 h-16 bg-on-surface/5 rounded-full flex items-center justify-center mx-auto mb-6 text-on-surface-variant/20">
                <Papicon icon="Users" size={32} />
              </div>
              <p class="text-on-surface-variant/40 font-bold italic">{m.evc_no_registrations()}</p>
            </div>
          {:else}
            <table class="w-full text-left">
              <thead class="bg-surface-container-high/50 border-b border-outline-variant/10">
                <tr>
                  <th class="px-8 py-5 text-xs font-medium text-on-surface-variant/40">{m.evc_col_user()}</th>
                  <th class="px-8 py-5 text-xs font-medium text-on-surface-variant/40">{m.evc_col_registered_at()}</th>
                  {#if event.formId}
                    <th class="px-8 py-5 text-xs font-medium text-on-surface-variant/40">{m.evc_col_form()}</th>
                  {/if}
                  <th class="px-8 py-5 text-xs font-medium text-on-surface-variant/40 text-right">{m.evc_col_actions()}</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-outline-variant/5">
                {#each registrations as reg}
                  <tr class="hover:bg-surface-container-low/50 transition-colors">
                    <td class="px-8 py-5">
                      <UserDisplay
                        userId={reg.userId}
                        name={reg.username || reg.userTag}
                        avatarUrl={reg.avatarUrl}
                        size="sm"
                        onClick={(userId) => router.goto(`/profile/${userId}`)}
                      />
                    </td>
                    <td class="px-8 py-5 text-sm text-on-surface-variant/60">
                      {new Date(reg.createdAt).toLocaleString('fr-FR')}
                    </td>
                    {#if event.formId}
                      <td class="px-8 py-5">
                        {#if reg.formData && typeof reg.formData === 'object'}
                          <div class="space-y-1 text-xs text-on-surface-variant/80">
                            {#each Object.entries(reg.formData) as [key, value]}
                              <div><span class="font-semibold text-on-surface-variant/50">{key}:</span> {value}</div>
                            {/each}
                          </div>
                        {:else}
                          <span class="text-[10px] text-on-surface-variant/30 italic">{m.evc_no_form_data()}</span>
                        {/if}
                      </td>
                    {/if}
                    <td class="px-8 py-5 text-right">
                      <button
                        onclick={() => removeRegistration(reg.userId)}
                        class="px-3 py-1.5 rounded-lg bg-red-500/10 text-red-500 text-xs font-medium hover:bg-red-500/20 transition-colors"
                      >
                        {m.evc_btn_remove_reg()}
                      </button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </div>
      {:else if activeTab === 'stats'}
        {#if event.type === 'CTF'}
          <div class="space-y-6">
            {#if stats && stats.challenges}
              <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                {#each stats.challenges as challenge}
                  <div class="bg-surface-container-low/30 rounded-xl border border-outline-variant/10 p-8 space-y-6 relative overflow-hidden group">
                    <div class="absolute top-0 left-0 w-2 h-full bg-emerald-500/30"></div>
                    
                    <div class="flex items-center justify-between">
                      <div>
                        <h4 class="text-xl font-semibold text-on-surface">{challenge.title}</h4>
                        <p class="text-[10px] font-bold text-on-surface-variant/40 mt-1 uppercase tracking-widest">
                          {challenge.points} pts | {challenge.xpReward} XP
                          {#if challenge.roleIdReward}
                            | Rôle: {challenge.roleIdReward}
                          {/if}
                        </p>
                      </div>
                      <div class="text-right">
                        <span class="px-3 py-1 bg-emerald-500/10 text-emerald-500 rounded-lg text-xs font-medium">
                          {m.evc_solves_count({ count: challenge.solveCount })}
                        </span>
                      </div>
                    </div>

                    <div class="space-y-3">
                      <span class="text-xs font-medium text-on-surface-variant/40">{m.evc_recent_solves()}</span>
                      {#if challenge.solves && challenge.solves.length > 0}
                        <div class="max-h-36 overflow-y-auto space-y-2 pr-2">
                          {#each challenge.solves as solve}
                            <div class="flex justify-between items-center bg-surface-container-high/30 rounded-xl px-4 py-2 border border-outline-variant/5">
                              <span class="text-xs font-bold text-on-surface">{solve.username}</span>
                              <span class="text-[11px] text-on-surface-variant/40">{new Date(solve.solvedAt).toLocaleTimeString()}</span>
                            </div>
                          {/each}
                        </div>
                      {:else}
                        <p class="text-xs text-on-surface-variant/30 italic">{m.evc_no_solves()}</p>
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
            {:else}
              <div class="py-20 text-center bg-surface-container-low/20 rounded-xl border border-dashed border-outline-variant/20">
                <div class="w-16 h-16 bg-on-surface/5 rounded-full flex items-center justify-center mx-auto mb-6 text-on-surface-variant/20">
                  <Papicon icon="Flag" size={32} />
                </div>
                <p class="text-on-surface-variant/40 font-bold italic">{m.evc_waiting_stats()}</p>
              </div>
            {/if}
          </div>
        {:else}
          <div class="bg-surface-container-low/30 rounded-xl border border-outline-variant/10 p-10 min-h-[500px] flex flex-col items-center justify-center relative overflow-hidden">
            <div class="absolute top-0 right-0 p-8 opacity-10">
              <Papicon icon="PieChart" size={120} />
            </div>
            
            {#if stats}
              {@const total = (Object.values(stats.distribution) as unknown[]).reduce<number>((a, b) => a + Number(b), 0) || 1}
              {@const colors = [
                '#6366f1', '#ec4899', '#06b6d4', '#f59e0b', '#10b981', '#8b5cf6', 
                '#f43f5e', '#f97316', '#84cc16', '#14b8a6', '#3b82f6', '#d946ef',
                '#a855f7', '#0ea5e9', '#facc15', '#fb923c', '#4ade80', '#2dd4bf',
                '#38bdf8', '#818cf8', '#c084fc', '#f472b6', '#fb7185'
              ]}
              {@const bgColors = [
                'bg-indigo-500', 'bg-pink-500', 'bg-cyan-500', 'bg-amber-500', 'bg-emerald-500', 'bg-violet-500',
                'bg-rose-500', 'bg-orange-500', 'bg-lime-500', 'bg-teal-500', 'bg-blue-500', 'bg-fuchsia-500',
                'bg-purple-500', 'bg-sky-500', 'bg-yellow-500', 'bg-orange-400', 'bg-green-400', 'bg-teal-400',
                'bg-sky-400', 'bg-indigo-400', 'bg-purple-400', 'bg-pink-400', 'bg-rose-400'
              ]}

              <div class="text-center mb-12">
                <div class="flex items-center justify-center gap-3 mb-4">
                  <span class="px-3 py-1 bg-primary/10 text-primary rounded-lg text-[11px] font-semibold uppercase tracking-widest">{m.evc_live_badge()}</span>
                </div>
                <h4 class="text-2xl font-semibold text-on-surface">{stats.questionText}</h4>
              </div>

              <div class="grid grid-cols-1 lg:grid-cols-2 gap-16 w-full max-w-5xl items-center">
                <!-- Pie Chart (SVG) -->
                <div class="flex justify-center">
                  <div class="relative w-64 h-64">
                    <svg viewBox="0 0 100 100" class="w-full h-full -rotate-90">
                      {#each Object.entries(stats.distribution) as [_idx, count], i}
                        {@const value = Number(count)}
                        {@const percentage = (value / total) * 100}
                        {@const prevValues = (Object.values(stats.distribution).slice(0, i) as unknown[]).reduce<number>((a, b) => a + Number(b), 0)}
                        {@const offset = (prevValues / total) * 100}
                        {@const isCorrect = i === currentQuestion?.correctOptionIndex}
                        
                        {#if percentage > 0}
                          <circle
                            r="40"
                            cx="50"
                            cy="50"
                            fill="transparent"
                            stroke={isCorrect ? '#10b981' : colors[i % colors.length]}
                            stroke-width="20"
                            stroke-dasharray="{percentage * 2.51} 251.2"
                            stroke-dashoffset="-{offset * 2.51}"
                            class="transition-all duration-1000 ease-out hover:opacity-80 cursor-pointer"
                          />
                        {/if}
                      {/each}
                    </svg>
                    <div class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                      <span class="text-lg font-semibold text-on-surface">{total}</span>
                      <span class="text-xs font-medium text-on-surface-variant/40">{m.evc_responses_unit()}</span>
                    </div>
                  </div>
                </div>

                <!-- Legend / Bars -->
                <div class="space-y-6">
                  {#each Object.entries(stats.distribution) as [_idx, count], i}
                    {@const value = Number(count)}
                    {@const percentage = Math.round((value / total) * 100)}
                    {@const optionText = (currentQuestion?.options as string[])?.[i] || `Option ${i + 1}`}
                    {@const isCorrect = i === currentQuestion?.correctOptionIndex}
                    
                    <div class="space-y-2">
                      <div class="flex justify-between items-center text-xs font-medium">
                        <div class="flex items-center gap-2">
                          {#if isCorrect}
                            <div class="w-4 h-4 bg-emerald-500 rounded-full flex items-center justify-center">
                              <Papicon icon="Check" size={10} class="text-white" />
                            </div>
                          {/if}
                          <span class={isCorrect ? 'text-emerald-500' : 'text-on-surface'}>{optionText}</span>
                        </div>
                        <span class="text-on-surface-variant/60">{value} ({percentage}%)</span>
                      </div>
                      <div class="h-3 w-full bg-surface-container-highest/20 rounded-full overflow-hidden">
                        <div 
                          class="h-full {isCorrect ? 'bg-emerald-500' : bgColors[i % bgColors.length]} rounded-full transition-all duration-1000 ease-out" 
                          style="width: {percentage}%"
                        ></div>
                      </div>
                    </div>
                  {/each}
                </div>
              </div>
            {:else}
              <div class="text-center space-y-4">
                <div class="w-16 h-16 bg-surface-container-high rounded-xl flex items-center justify-center mx-auto mb-6 animate-pulse">
                  <Papicon icon="Activity" size={32} class="text-on-surface-variant/20" />
                </div>
                <p class="text-on-surface-variant/40 font-bold italic">{m.evc_waiting_first_responses()}</p>
              </div>
            {/if}
          </div>
        {/if}
      {:else}
        <div class="bg-surface-container-low/30 rounded-xl border border-outline-variant/10 overflow-hidden">
          <table class="w-full text-left">
            <thead class="bg-surface-container-high/50 border-b border-outline-variant/10">
              <tr>
                <th class="px-8 py-5 text-xs font-medium text-on-surface-variant/40">{m.evc_col_user()}</th>
                <th class="px-8 py-5 text-xs font-medium text-on-surface-variant/40">{m.evc_col_score()}</th>
                <th class="px-8 py-5 text-xs font-medium text-on-surface-variant/40">
                  {event.type === 'CTF' ? m.evc_col_last_solve() : m.evc_col_last_activity()}
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-outline-variant/5">
              {#each event.participants || [] as p}
                {@const lastResp = stats?.latestResponses?.find((r: any) => r.userId === p.userId) ?? stats?.responses?.find((r: any) => r.userId === p.userId)}
                <tr class="hover:bg-surface-container-low/50 transition-colors">
                  <td class="px-8 py-5">
                    <UserDisplay
                      userId={p.userId}
                      name={p.profile?.displayName || p.username || p.userTag}
                      avatarUrl={p.profile?.avatarUrl}
                      size="sm"
                      onClick={(userId) => router.goto(`/profile/${userId}`)}
                    />
                  </td>
                  <td class="px-8 py-5">
                    <span class="font-semibold text-primary">{p.score} pts</span>
                  </td>
                  <td class="px-8 py-5">
                    {#if event.type === 'CTF'}
                      {#if p.lastSolveAt}
                        <span class="text-xs text-on-surface-variant/60">
                          {new Date(p.lastSolveAt).toLocaleString()}
                        </span>
                      {:else}
                        <span class="text-[10px] text-on-surface-variant/40">{m.evc_no_solves_yet()}</span>
                      {/if}
                    {:else}
                      {#if lastResp}
                        {@const respText = lastResp.optionLabel || (currentQuestion?.options as string[])?.[lastResp.optionIndex] || `Option ${lastResp.optionIndex + 1}`}
                        <span class="px-3 py-1 rounded-lg text-[11px] font-semibold uppercase tracking-widest {lastResp.isCorrect ? 'bg-emerald-500/10 text-emerald-600' : 'bg-red-500/10 text-red-600'}">
                          {respText}
                        </span>
                      {:else}
                        <span class="text-[10px] text-on-surface-variant/40">{m.evc_no_response_yet()}</span>
                      {/if}
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  {:else}
    <div class="flex items-center justify-center py-40">
      <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
    </div>
  {/if}
</ModulePage>
