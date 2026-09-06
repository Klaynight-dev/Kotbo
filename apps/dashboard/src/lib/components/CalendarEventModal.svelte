<script lang="ts">
  import Papicon from './Papicon.svelte';
  import ActionButton from './ActionButton.svelte';
  import Modal from './Modal.svelte';
  import { localInitialAvatar } from '../discordMedia';
  import { escapeHtml } from '../emojiParser';

  const {
    show = false,
    event = null,
    onClose = () => {},
    extraActions = null
  } = $props<{
    show?: boolean;
    event?: any;
    onClose?: (e?: any) => void;
    extraActions?: any;
  }>();

  function formatDate(date: Date) {
    return new Date(date).toLocaleString('fr-FR', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function formatDuration(seconds: number) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes} min`;
  }

  function getStatusColor(status: string) {
    switch (status) {
      case 'PRESENT': return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
      case 'EXCUSED': 
      case 'ABSENT_CHECKED': return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
      case 'ABSENT': return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300';
      case 'SCHEDULED': return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300';
      case 'IN_PROGRESS': return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
      case 'COMPLETED': return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
      default: return 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-400';
    }
  }

  /**
   * `event.details` vient d'un motif d'absence ou d'une description de reunion,
   * saisis par les membres : on echappe avant d'ajouter le moindre balisage.
   */
  function interpretMarkdown(text: string) {
    if (!text) return '';
    return escapeHtml(text)
      .replace(/### (.*)/g, '<h5 class="text-[13px] font-medium text-primary mt-4 mb-2">$1</h5>')
      .replace(/## (.*)/g, '<h4 class="text-sm font-semibold text-on-surface mt-6 mb-3 border-b border-outline-variant/20 pb-1">$1</h4>')
      .replace(/# (.*)/g, '<h3 class="text-lg font-semibold text-on-surface mt-8 mb-4">$1</h3>')
      .replace(/\*\*(.*)\*\*/g, '<strong class="font-semibold text-primary">$1</strong>')
      .replace(/\*(.*)\*/g, '<em class="italic">$1</em>')
      .replace(/^- (.*)/mg, '<li class="ml-4 list-disc text-sm text-on-surface-variant">$1</li>')
      .replace(/\n/g, '<br/>');
  }
</script>

{#if show && event}
  <Modal
    open={show}
    onClose={onClose}
    title={event.type === 'absence' ? 'Détails Absence' : event.type === 'vocal' ? 'Activité Vocale' : 'Réunion Staff'}
    size="lg"
    showCloseButton={false}
  >
    <div class="flex flex-col h-full">
      <!-- Custom header with icon -->
      <header class="p-8 border-b border-outline-variant/30 {event.type === 'absence' ? 'bg-amber-500/10' : event.type === 'vocal' ? 'bg-primary/10' : 'bg-emerald-500/10'} flex items-center justify-between shrink-0 -mt-6 -mx-6">
        <div class="flex items-center gap-4">
          <div class="w-14 h-14 {event.type === 'absence' ? 'bg-amber-500 shadow-amber-500/20' : event.type === 'vocal' ? 'bg-primary shadow-primary/20' : 'bg-emerald-500 shadow-emerald-500/20'} rounded-lg flex items-center justify-center shadow-lg">
            <Papicon
              icon={event.type === 'absence' ? 'calendar-off' : event.type === 'vocal' ? 'mic' : 'users'}
              size={28}
              class="text-white"
            />
          </div>
          <div>
            <div class="flex items-center gap-2 mt-1">
              {#if event.type !== 'meeting'}
                <img
                  src={event.avatarUrl || localInitialAvatar(event.staffName)}
                  alt=""
                  class="w-5 h-5 rounded-full"
                />
              {/if}
              <span class="text-sm font-bold text-on-surface-variant">{event.staffName || (event.type === 'meeting' ? 'Réunion Collective' : 'Membre inconnu')}</span>
            </div>
          </div>
        </div>
        <button onclick={onClose} class="w-10 h-10 rounded-full flex items-center justify-center hover:bg-surface-hover transition-colors">
          <Papicon icon="x" size={24} />
        </button>
      </header>

      <!-- Content -->
      <div class="p-8 space-y-6 overflow-y-auto custom-scrollbar flex-1">
        <div class="grid grid-cols-2 gap-6">
          <div class="space-y-1">
            <p class="text-[10px] font-semibold uppercase tracking-wider text-primary">Début</p>
            <p class="text-sm font-bold text-on-surface">{formatDate(event.start)}</p>
          </div>
          <div class="space-y-1">
            <p class="text-[10px] font-semibold uppercase tracking-wider text-primary">Fin</p>
            <p class="text-sm font-bold text-on-surface">
              {event.end ? formatDate(event.end) : (event.isIndefinite ? 'Durée indéterminée' : 'En cours')}
            </p>
          </div>
        </div>

        {#if event.type === 'vocal' && event.details}
          <div class="p-4 bg-surface-container rounded-lg border border-outline-variant/30 flex items-center gap-4">
             <div class="w-10 h-10 bg-primary/10 rounded-xl flex items-center justify-center text-primary">
                <Papicon icon="volume-2" size={20} />
             </div>
             <div>
                <p class="text-xs font-medium text-on-surface-variant">Salon Vocal</p>
                <p class="text-sm font-bold text-on-surface">{event.details}</p>
             </div>
             {#if event.raw?.durationSeconds}
               <div class="ml-auto text-right">
                  <p class="text-xs font-medium text-on-surface-variant">Durée</p>
                  <p class="text-sm font-semibold text-primary">{formatDuration(event.raw.durationSeconds)}</p>
               </div>
             {/if}
          </div>
        {/if}

        {#if event.type === 'absence'}
          <div class="space-y-4">
            <div class="grid grid-cols-2 gap-4">
               <div class="p-3 bg-surface-container rounded-xl border border-outline-variant/20">
                  <p class="text-xs font-medium text-on-surface-variant">Type</p>
                  <p class="text-xs font-bold text-amber-600">{event.raw?.type || 'Autre'}</p>
               </div>
               <div class="p-3 bg-surface-container rounded-xl border border-outline-variant/20">
                  <p class="text-xs font-medium text-on-surface-variant">Statut</p>
                  <p class="text-xs font-bold {event.raw?.status === 'APPROVED' ? 'text-emerald-600' : 'text-amber-600'}">
                    {event.raw?.status === 'APPROVED' ? 'Approuvé' : event.raw?.status === 'PENDING' ? 'En attente' : 'Validé'}
                  </p>
               </div>
            </div>

            <div class="space-y-1">
              <p class="text-[10px] font-semibold uppercase tracking-wider text-primary">Raison / Motif</p>
              <div class="p-4 bg-surface-container-low rounded-lg border border-outline-variant/20 italic text-sm text-on-surface leading-relaxed">
                "{event.details || event.title}"
              </div>
            </div>

            {#if event.raw?.superior?.displayName}
              <div class="flex items-center gap-3 px-1">
                <div class="w-8 h-8 bg-emerald-500/10 rounded-full flex items-center justify-center text-emerald-600">
                  <Papicon icon="user-check" size={16} />
                </div>
                <p class="text-xs font-medium text-on-surface-variant">
                  Référent: <span class="font-bold text-on-surface">{event.raw.superior.displayName}</span>
                </p>
              </div>
            {/if}
          </div>
        {/if}

        {#if event.type === 'meeting'}
          <div class="space-y-6">
            {#if event.details}
              <div class="p-6 bg-surface-container rounded-xl border border-outline-variant/30">
                <div class="text-sm text-on-surface leading-relaxed prose-invert prose-sm">
                  {@html interpretMarkdown(event.details)}
                </div>
              </div>
            {/if}

            <div class="space-y-4">
              <h4 class="text-[10px] font-semibold text-on-surface-variant uppercase tracking-widest px-1">Liste des présences</h4>
              <div class="grid grid-cols-1 gap-2">
                {#if event.raw?.presences && event.raw.presences.length > 0}
                  {#each event.raw.presences as presence}
                    <div class="flex items-center justify-between p-3 bg-surface-container-low rounded-lg border border-outline-variant/10">
                      <div class="flex items-center gap-3">
                        <div class="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center text-xs font-semibold text-primary overflow-hidden">
                          {#if presence.staffMember?.avatarUrl}
                            <img src={presence.staffMember.avatarUrl} alt="" class="w-full h-full object-cover" />
                          {:else}
                            {presence.staffMember?.displayName?.slice(0, 2).toUpperCase() || '??'}
                          {/if}
                        </div>
                        <div>
                          <p class="text-sm font-bold text-on-surface">{presence.staffMember?.displayName || 'Membre'}</p>
                          {#if presence.note}
                            <p class="text-[10px] text-on-surface-variant line-clamp-1">{presence.note}</p>
                          {/if}
                        </div>
                      </div>
                      <span class="text-[11px] font-semibold uppercase tracking-wider px-2 py-1 rounded-full {getStatusColor(presence.status)}">
                        {presence.status}
                      </span>
                    </div>
                  {/each}
                {:else}
                  <div class="flex flex-col items-center justify-center py-10 bg-surface-container-low rounded-lg border border-dashed border-outline-variant/30">
                    <Papicon icon="users" size={32} class="text-on-surface-variant/20 mb-2" />
                    <p class="text-xs text-on-surface-variant font-medium">Aucune donnée de présence</p>
                  </div>
                {/if}
              </div>
            </div>
          </div>
        {/if}
      </div>

      <!-- Footer -->
      <footer class="p-8 border-t border-outline-variant/30 bg-surface-container-lowest flex items-center justify-end gap-4 shrink-0 -mx-6 -mb-6">
        {#if extraActions}
          {@render extraActions()}
        {/if}
        <ActionButton
          variant="muted"
          onClick={onClose}
          label="Fermer"
        />
      </footer>
    </div>
  </Modal>
{/if}
