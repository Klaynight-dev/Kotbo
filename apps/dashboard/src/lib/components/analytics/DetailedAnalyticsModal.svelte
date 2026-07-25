<script lang="ts">
  import { portal } from '../../actions/portal';
  import Papicon from '../Papicon.svelte';
  import Chart from '../charts/Chart.svelte';
  import { m } from '../../i18n';

  let {
    open = false,
    title,
    subtitle,
    icon,
    iconColorClass = 'text-primary',
    iconBgClass = 'bg-primary/10',
    type,
    data = [],
    chartData,
    chartOptions,
    onClose,
    onOpenMember,
    fmt,
    fmtH,
    getSanctionColor,
  } = $props<{
    open: boolean;
    title: string;
    subtitle: string;
    icon: string;
    iconColorClass?: string;
    iconBgClass?: string;
    type: 'messages' | 'voice' | 'channels' | 'moderators' | 'sanctioned' | 'staff' | 'recent_sanctions';
    data: any[];
    chartData?: any;
    chartOptions?: any;
    onClose: () => void;
    onOpenMember?: (id: string, name: string) => void;
    fmt?: (n: number) => string;
    fmtH?: (mins: number) => string;
    getSanctionColor?: (type: string) => string;
  }>();

  const getAvatar = (url: string | null) => url || 'https://cdn.discordapp.com/embed/avatars/0.png';

  let searchQuery = $state('');
  let sortKey = $state('volume'); // 'volume' or 'name'
  let sortOrder = $state<'asc'|'desc'>('desc');
  let currentPage = $state(1);
  const itemsPerPage = 50;

  $effect(() => {
    // Reset page when search or sort changes
    searchQuery;
    sortKey;
    sortOrder;
    currentPage = 1;
  });

  const filteredData = $derived(data.filter(item => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    const name = item.name || item.username || item.channelName || item.channelId || item.moderatorTag || item.targetTag || '';
    const reason = item.reason || '';
    return name.toLowerCase().includes(q) || reason.toLowerCase().includes(q);
  }));

  const sortedData = $derived([...filteredData].sort((a, b) => {
    let valA, valB;
    if (sortKey === 'name') {
      valA = (a.name || a.username || a.channelName || a.channelId || a.moderatorTag || a.targetTag || '').toLowerCase();
      valB = (b.name || b.username || b.channelName || b.channelId || b.moderatorTag || b.targetTag || '').toLowerCase();
    } else {
      valA = a.messageCount ?? a.voiceTimeSeconds ?? a.messagesCount ?? a.count ?? a.score ?? (a.createdAt ? new Date(a.createdAt).getTime() : 0);
      valB = b.messageCount ?? b.voiceTimeSeconds ?? b.messagesCount ?? b.count ?? b.score ?? (b.createdAt ? new Date(b.createdAt).getTime() : 0);
    }
    
    if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
    if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
    return 0;
  }));

  const totalPages = $derived(Math.max(1, Math.ceil(sortedData.length / itemsPerPage)));
  const paginatedData = $derived(sortedData.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage));
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div use:portal class="fixed inset-0 z-100 flex items-center justify-center p-4 sm:p-6" onclick={onClose}>
    <div class="absolute inset-0 bg-surface/80"></div>
    
    <div 
      class="relative w-full max-w-5xl h-[95vh] flex flex-col premium-card rounded-xl overflow-hidden animate-in fade-in zoom-in-95 duration-300"
      onclick={(e) => e.stopPropagation()}
    >
      <!-- Header -->
      <div class="p-6 md:p-8 flex items-start justify-between border-b border-outline-variant/10 shrink-0">
        <div class="flex items-center gap-4">
          <div class="p-3 rounded-lg {iconBgClass} {iconColorClass}">
            <Papicon {icon} size={24} />
          </div>
          <div>
            <h3 class="text-xl md:text-2xl font-semibold text-on-surface">{title}</h3>
            <p class="text-xs font-bold text-on-surface-variant/60">{subtitle} {m.d7_dam_results_of({ count: filteredData.length, total: data.length })}</p>
          </div>
        </div>
        <button 
          onclick={onClose}
          class="p-2 rounded-xl bg-surface-container-high/40 hover:bg-surface-container-high hover:text-error text-on-surface-variant transition-colors"
        >
          <Papicon icon="X" size={20} />
        </button>
      </div>

      <!-- Scrollable Content -->
      <div class="flex-1 overflow-y-auto custom-scrollbar p-6 md:p-8 space-y-8">
        
        {#if chartData}
          <div class="h-[300px]">
             <Chart data={chartData} type="bar" height={300} options={chartOptions} />
          </div>
        {/if}

        <!-- Toolbar: Search & Sort -->
        <div class="flex flex-col md:flex-row gap-4 p-4 rounded-xl bg-surface-container-high/20 border border-outline-variant/5">
          <div class="flex-1 relative">
            <div class="absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant/40">
              <Papicon icon="MagnifyingGlass" size={20} />
            </div>
            <input 
              type="text" 
              bind:value={searchQuery}
              placeholder={m.d7_dam_search_placeholder()}
              class="w-full bg-surface-container-high/40 text-on-surface text-sm font-bold rounded-lg pl-12 pr-4 py-3 border border-outline-variant/5 focus:border-primary/50 focus:outline-none transition-colors placeholder:text-on-surface-variant/40"
            />
          </div>
          <div class="flex gap-2">
            <select 
              bind:value={sortKey}
              class="bg-surface-container-high/40 text-on-surface text-sm font-bold rounded-lg px-4 py-3 border border-outline-variant/5 focus:border-primary/50 focus:outline-none transition-colors appearance-none cursor-pointer"
            >
              <option value="volume">{m.d7_dam_sort_volume()}</option>
              <option value="name">{m.d7_dam_sort_alpha()}</option>
            </select>
            <button 
              onclick={() => sortOrder = sortOrder === 'asc' ? 'desc' : 'asc'}
              class="px-4 py-3 rounded-lg bg-surface-container-high/40 hover:bg-surface-container-high text-on-surface transition-colors flex items-center justify-center gap-2 border border-outline-variant/5"
            >
              <Papicon icon={sortOrder === 'desc' ? 'SortDescending' : 'SortAscending'} size={18} />
            </button>
          </div>
        </div>

        <!-- Data List -->
        <div class="space-y-3">
          {#each paginatedData as item, i}
            {@const globalIndex = (currentPage - 1) * itemsPerPage + i + 1}
            
            <!-- MESSAGES / VOICE -->
            {#if type === 'messages' || type === 'voice'}
              <button 
                onclick={() => onOpenMember?.(item.userId, item.name || item.username)}
                class="w-full flex items-center justify-between p-4 rounded-lg bg-surface-container-high/20 border border-outline-variant/5 hover:bg-surface-container-high/60 transition-all text-left group"
              >
                <div class="flex items-center gap-4">
                  <div class="w-8 text-center text-xs font-semibold text-on-surface-variant/40">{globalIndex}</div>
                  <div class="relative">
                    <img src={getAvatar(item.avatarUrl)} alt="" class="w-10 h-10 rounded-xl object-cover" />
                    <div class="absolute -bottom-1 -right-1 w-3 h-3 rounded-full border-2 border-surface {type === 'messages' ? 'bg-primary' : 'bg-emerald-500'}"></div>
                  </div>
                  <p class="text-base font-semibold text-on-surface">@{item.name || item.username}</p>
                </div>
                <div class="flex items-center gap-6">
                  <div class="text-right">
                    <p class="text-[10px] font-semibold {type === 'messages' ? 'text-primary' : 'text-emerald-500'} uppercase tracking-widest">{type === 'messages' ? m.d7_dam_messages() : m.d7_dam_minutes()}</p>
                    <p class="text-base font-semibold text-on-surface">{(type === 'messages' ? item.messageCount : Math.round(item.voiceTimeSeconds / 60)).toLocaleString('fr-FR')}</p>
                  </div>
                  <Papicon icon="ArrowRight" size={16} class="opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              </button>

            <!-- CHANNELS -->
            {:else if type === 'channels'}
              <div class="w-full flex items-center justify-between p-4 rounded-lg bg-surface-container-high/20 border border-outline-variant/5">
                <div class="flex items-center gap-4">
                  <div class="w-8 text-center text-xs font-semibold text-on-surface-variant/40">{globalIndex}</div>
                  <div class="bg-secondary/10 p-3 rounded-xl text-secondary">
                    <Papicon icon="Hash" size={20} />
                  </div>
                  <p class="text-base font-semibold text-on-surface">#{item.channelName || item.name || item.channelId}</p>
                </div>
                <div class="text-right">
                  <p class="text-[10px] font-semibold text-secondary uppercase tracking-widest">{m.d7_dam_volume()}</p>
                  <p class="text-base font-semibold text-on-surface">{(item.messagesCount || item.count).toLocaleString('fr-FR')}</p>
                </div>
              </div>

            <!-- MODERATORS -->
            {:else if type === 'moderators'}
              <button 
                onclick={() => onOpenMember?.(item.userId, item.moderatorTag)}
                class="w-full flex items-center justify-between p-4 rounded-lg bg-surface-container-high/20 border border-outline-variant/5 hover:bg-surface-container-high/60 transition-all text-left"
              >
                <div class="flex items-center gap-4">
                  <div class="w-8 text-center text-xs font-semibold text-on-surface-variant/40">{globalIndex}</div>
                  <img src={getAvatar(item.avatarUrl)} alt="" class="w-10 h-10 rounded-xl object-cover" />
                  <p class="text-base font-semibold text-on-surface">@{item.moderatorTag}</p>
                </div>
                <div class="text-right">
                  <p class="text-[10px] font-semibold text-primary uppercase tracking-widest">{m.d7_dam_actions()}</p>
                  <p class="text-base font-semibold text-on-surface">{item.count}</p>
                </div>
              </button>

            <!-- SANCTIONED -->
            {:else if type === 'sanctioned'}
              <button 
                onclick={() => onOpenMember?.(item.targetUserId, item.targetTag)}
                class="w-full flex items-center justify-between p-4 rounded-lg bg-surface-container-high/20 border border-outline-variant/5 hover:bg-surface-container-high/60 transition-all text-left"
              >
                <div class="flex items-center gap-4">
                  <div class="w-8 text-center text-xs font-semibold text-on-surface-variant/40">{globalIndex}</div>
                  <img src={getAvatar(item.avatarUrl)} alt="" class="w-10 h-10 rounded-xl object-cover" />
                  <p class="text-base font-semibold text-on-surface">@{item.targetTag}</p>
                </div>
                <div class="text-right">
                  <p class="text-[10px] font-semibold text-rose-500 uppercase tracking-widest">{m.d7_dam_sanctions()}</p>
                  <p class="text-base font-semibold text-on-surface">{item.count}</p>
                </div>
              </button>

            <!-- STAFF LEADERBOARD -->
            {:else if type === 'staff'}
              <button 
                onclick={() => onOpenMember?.(item.userId, item.name)}
                class="w-full flex items-center gap-4 p-4 rounded-lg bg-surface-container-high/20 hover:bg-surface-container-high/50 border border-outline-variant/5 transition-all text-left group"
              >
                <div class="flex items-center justify-center w-8 h-8 rounded-full font-semibold text-xs {globalIndex <= 3 ? 'bg-amber-500/10 text-amber-500' : 'bg-on-surface/5 text-on-surface-variant/30 shrink-0'}">
                  {globalIndex}
                </div>
                <div class="relative shrink-0">
                  <img src={getAvatar(item.avatarUrl)} alt="" class="w-10 h-10 rounded-xl object-cover" />
                  <div class="absolute -bottom-1 -right-1 w-3 h-3 rounded-full border-2 border-surface bg-emerald-500"></div>
                </div>
                <div class="flex-1 min-w-0">
                  <span class="text-base font-semibold text-on-surface block truncate">{item.name}</span>
                  <span class="text-[10px] font-bold text-on-surface-variant/40 uppercase tracking-widest">{item.grade || m.d7_staff()}</span>
                </div>
                <div class="hidden md:flex items-center gap-6 mr-4 shrink-0">
                  <div class="text-right">
                    <p class="text-[11px] font-semibold text-on-surface-variant/30 uppercase tracking-widest">{m.d7_dam_messages()}</p>
                    <p class="text-xs font-bold text-on-surface">{fmt?.(item.messages)}</p>
                  </div>
                  <div class="text-right">
                    <p class="text-[11px] font-semibold text-on-surface-variant/30 uppercase tracking-widest">{m.d7_dam_voice()}</p>
                    <p class="text-xs font-bold text-on-surface">{fmtH?.(item.voiceMinutes)}</p>
                  </div>
                </div>
                <div class="text-right pl-4 border-l border-outline-variant/10 shrink-0">
                  <p class="text-[11px] font-semibold text-primary uppercase tracking-widest">{m.d7_dam_score()}</p>
                  <p class="text-lg font-semibold text-primary">{fmt?.(item.score)}</p>
                </div>
              </button>

            <!-- RECENT SANCTIONS -->
            {:else if type === 'recent_sanctions'}
              <div class="flex flex-col md:flex-row md:items-center justify-between p-5 rounded-xl bg-surface-container-high/30 border border-outline-variant/10 hover:bg-surface-container-high/50 transition-all group gap-4">
                <div class="flex items-center gap-4">
                  <div class="w-8 text-center text-xs font-semibold text-on-surface-variant/40 hidden md:block">{globalIndex}</div>
                  <button 
                    onclick={() => onOpenMember?.(item.targetUserId, item.targetTag)}
                    class="w-12 h-12 rounded-lg overflow-hidden bg-on-surface/5 flex items-center justify-center transition-transform shrink-0"
                  >
                    <img src={getAvatar(item.targetAvatarUrl)} alt="" class="w-full h-full object-cover" />
                  </button>
                  <div>
                    <div class="flex items-center gap-2">
                      <p class="text-sm font-semibold text-on-surface">@{item.targetTag}</p>
                      {#if getSanctionColor}
                        <span class="px-2 py-0.5 rounded-lg text-[11px] font-semibold tracking-widest uppercase" style="background: {getSanctionColor(item.type)}20; color: {getSanctionColor(item.type)}">{item.type}</span>
                      {/if}
                    </div>
                    <p class="text-xs font-medium text-on-surface-variant/60 mt-0.5 line-clamp-1">{item.reason || m.d7_dam_no_reason()}</p>
                    <p class="text-[10px] text-on-surface-variant/40 mt-1">{new Date(item.createdAt).toLocaleString('fr-FR')}</p>
                  </div>
                </div>
                <div class="flex items-center justify-between md:justify-end gap-6 border-t md:border-t-0 border-outline-variant/5 pt-3 md:pt-0 shrink-0">
                  <div class="text-right">
                    <p class="text-[11px] font-semibold text-on-surface-variant/40 uppercase tracking-widest">{m.d7_dam_moderator()}</p>
                    <div class="flex items-center gap-2 mt-0.5">
                      <img src={getAvatar(item.moderatorAvatarUrl)} alt="" class="w-5 h-5 rounded-md object-cover" />
                      <p class="text-xs font-bold text-on-surface">@{item.moderatorTag}</p>
                    </div>
                  </div>
                  <Papicon icon="CaretRight" size={16} class="text-on-surface-variant/20 group-hover:translate-x-1 transition-transform" />
                </div>
              </div>
            {/if}
          {/each}

          {#if paginatedData.length === 0}
            <div class="py-20 text-center opacity-40">
              <Papicon icon="Ghost" size={48} class="mx-auto mb-4" />
              <p class="text-sm font-bold">{m.d7_no_data_found()}</p>
            </div>
          {/if}
        </div>

        <!-- Pagination -->
        {#if totalPages > 1}
          <div class="flex items-center justify-between pt-4 border-t border-outline-variant/10">
            <button 
              onclick={() => currentPage = Math.max(1, currentPage - 1)}
              disabled={currentPage === 1}
              class="px-4 py-2 rounded-xl bg-surface-container-high/40 hover:bg-surface-container-high text-xs font-bold text-on-surface transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              <Papicon icon="CaretLeft" size={14} />
              {m.d7_dam_prev()}
            </button>
            <span class="text-xs font-bold text-on-surface-variant/60">{m.d7_dam_page({ current: currentPage, total: totalPages })}</span>
            <button 
              onclick={() => currentPage = Math.min(totalPages, currentPage + 1)}
              disabled={currentPage === totalPages}
              class="px-4 py-2 rounded-xl bg-surface-container-high/40 hover:bg-surface-container-high text-xs font-bold text-on-surface transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {m.d7_dam_next()}
              <Papicon icon="CaretRight" size={14} />
            </button>
          </div>
        {/if}

      </div>
    </div>
  </div>
{/if}

<style>
  .premium-card {
    background: rgba(var(--color-surface-container-low), 0.95);
    border: 1px solid rgba(var(--color-outline-variant), 0.2);
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
  }

  .custom-scrollbar::-webkit-scrollbar {
    width: 6px;
  }
  .custom-scrollbar::-webkit-scrollbar-track {
    background: transparent;
  }
  .custom-scrollbar::-webkit-scrollbar-thumb {
    background: rgba(var(--color-outline-variant), 0.2);
    border-radius: 10px;
  }
</style>

