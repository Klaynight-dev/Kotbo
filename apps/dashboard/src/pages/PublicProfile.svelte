<script lang="ts">
  import { onMount } from 'svelte';
  import { memberAvatarSrc } from '../lib/discordMedia';
  import { API_BASE_URL } from '../lib/api';
  import { authStore } from '../lib/stores/auth.svelte';
  import { router } from 'tinro';
  import Papicon from '../lib/components/Papicon.svelte';
  import MetricCard from '../lib/components/MetricCard.svelte';

  interface Props {
    userId: string;
  }
  const { userId }: Props = $props();

  let profile: any = $state(null);
  let loading = $state(true);
  let error = $state('');

  onMount(async () => {
    try {
      // Fetch public profile snapshot
      const res = await fetch(`${API_BASE_URL}/api/public/profile/${userId}`);
      if (!res.ok) {
        if (res.status === 404) throw new Error('Utilisateur introuvable');
        throw new Error('Erreur lors de la récupération du profil');
      }
      profile = await res.json();
    } catch (err: any) {
      error = err.message || 'Impossible de charger le profil public';
    } finally {
      loading = false;
    }
  });

  function formatDate(date: string | Date | null | undefined) {
    if (!date) return '-';
    return new Date(date).toLocaleDateString('fr-FR', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    });
  }

  function getDurationSince(value: string | null | undefined) {
    if (!value) return 'Inconnu';
    const start = new Date(value);
    const now = new Date();
    let years = now.getFullYear() - start.getFullYear();
    let months = now.getMonth() - start.getMonth();
    if (months < 0) { years--; months += 12; }

    const parts: string[] = [];
    if (years > 0) parts.push(`${years} an${years > 1 ? 's' : ''}`);
    if (months > 0) parts.push(`${months} mois`);
    if (parts.length === 0) {
       const days = Math.floor((now.getTime() - start.getTime()) / 86400000);
       return days <= 0 ? "Aujourd'hui" : `${days} j`;
    }
    return parts.join(', ');
  }

  function formatTimeAgo(dateStr: string | null) {
    if (!dateStr) return 'Jamais';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return "À l'instant";
    if (diffMins < 60) return `Il y a ${diffMins} min`;
    if (diffHours < 24) return `Il y a ${diffHours}h`;
    if (diffDays === 1) return "Hier";
    return `Il y a ${diffDays} jours`;
  }
</script>

<div class="min-h-screen bg-surface-container-lowest/30 pb-24 font-sans text-on-surface antialiased">
  <!-- Decorative top background grid/neon -->
  <div class="absolute top-0 inset-x-0 h-[500px] bg-linear-to-b from-primary/5 to-transparent blur-none hidden pointer-events-none"></div>

  <div class="max-w-6xl mx-auto px-6 pt-16 relative z-10">
    <!-- Back Button -->
    <div class="mb-8">
      <button onclick={() => router.goto('/')} class="group inline-flex items-center gap-2 rounded-xl bg-surface-container-low/60 hover:bg-surface-container-high/80 border border-outline-variant/10 px-5 py-2.5 text-[13px] font-medium text-on-surface-variant transition-all hover:">
        <Papicon icon="ArrowLeft" size={14} class="transition-transform group-hover:-translate-x-1" />
        Retour
      </button>
    </div>

    {#if loading}
      <!-- Loading Skeleton -->
      <div class="space-y-10 animate-pulse">
        <div class="h-64 bg-surface-container-high/40 rounded-xl border border-outline-variant/5"></div>
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-6">
          <div class="h-32 bg-surface-container-high/40 rounded-xl"></div>
          <div class="h-32 bg-surface-container-high/40 rounded-xl"></div>
          <div class="h-32 bg-surface-container-high/40 rounded-xl"></div>
          <div class="h-32 bg-surface-container-high/40 rounded-xl"></div>
        </div>
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div class="lg:col-span-2 h-96 bg-surface-container-high/30 rounded-xl"></div>
          <div class="h-96 bg-surface-container-high/30 rounded-xl"></div>
        </div>
      </div>
    {:else if error}
      <!-- Error Panel -->
      <div class="flex flex-col items-center justify-center py-24 text-center max-w-xl mx-auto">
        <div class="w-20 h-20 rounded-xl bg-rose-500/10 text-rose-500 border border-rose-500/20 flex items-center justify-center mb-6 shadow-sm">
          <Papicon icon="AlertTriangle" size={36} />
        </div>
        <h3 class="text-lg font-semibold tracking-tight text-on-surface font-headline">Profil Introuvable</h3>
        <p class="mt-4 text-base font-bold text-on-surface-variant/60 leading-relaxed">
          {error}. Vérifiez que l'identifiant est correct ou que le compte n'a pas été restreint.
        </p>
        <button onclick={() => router.goto('/')} class="mt-10 inline-flex items-center gap-3 rounded-lg bg-primary px-8 py-4 text-[13px] font-medium text-on-primary shadow-sm shadow-primary/20 hover: active:scale-[0.98] transition-all">
          <Papicon icon="Home" size={16} />
          Retour à l'accueil
        </button>
      </div>
    {:else if profile}
      
      <!-- ── Hero Banner Section ──────────────────────────────────────── -->
      <div class="relative overflow-hidden rounded-xl border border-outline-variant/10 bg-surface-container-lowest shadow-sm mb-8 group">
        <!-- Banner Image/Gradient -->
        <div class="relative h-48 md:h-64 overflow-hidden bg-surface-container-low">
          {#if profile.banner}
            <img src={profile.banner} alt="Banner" class="w-full h-full object-cover transition-transform duration-1000 " />
          {:else}
            <!-- Elegant animated mesh gradient -->
            <div class="absolute inset-0 bg-linear-to-br from-indigo-900/40 via-purple-950/20 to-surface-container-low blur-none hidden scale-125"></div>
            <div class="absolute -top-12 -left-12 w-64 h-64 bg-primary/10 rounded-full blur-none hidden animate-pulse"></div>
            <div class="absolute -bottom-12 -right-12 w-80 h-80 bg-secondary/5 rounded-full blur-none hidden animate-pulse duration-5000"></div>
          {/if}
          <!-- Fade Overlay -->
          <div class="absolute inset-0 bg-linear-to-b from-transparent via-transparent to-surface-container-lowest"></div>
          
          <div class="absolute top-6 right-6 z-20">
            <span class="inline-flex items-center gap-2 rounded-full bg-surface-container-lowest/30 border border-outline-variant/10 px-4 py-2 text-[11px] font-semibold text-white uppercase tracking-wider shadow-lg">
              <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
              Profil Communautaire
            </span>
          </div>
        </div>

        <!-- Avatar & User Info Overlap -->
        <div class="relative px-8 pb-10 -mt-16 md:-mt-20">
          <div class="flex flex-col md:flex-row items-center md:items-end justify-between gap-6 text-center md:text-left">
            <div class="flex flex-col md:flex-row items-center md:items-end gap-6">
              <!-- Avatar Frame -->
              <div class="relative shrink-0">
                <div class="absolute -inset-2.5 bg-primary/10 rounded-[2.2rem] blur-xl opacity-30 group-hover:opacity-40 transition-opacity"></div>
                <div class="relative w-32 h-32 md:w-36 md:h-36 rounded-[2.2rem] border-[5px] border-surface-container-lowest shadow-sm overflow-hidden bg-surface-container-low transition-transform duration-500 group-hover:">
                  <img src={memberAvatarSrc(profile.avatar, profile.displayName || profile.username, profile.userId)} alt={profile.username} class="w-full h-full object-cover" />
                </div>
              </div>

              <!-- Name & User details -->
              <div class="space-y-2 pb-2">
                <h1 class="text-lg md:text-xl font-semibold text-on-surface tracking-tight font-headline leading-none">
                  {profile.displayName || profile.username}
                </h1>
                <div class="flex flex-wrap items-center justify-center md:justify-start gap-2.5">
                  <p class="text-base text-on-surface-variant/70 font-bold">@{profile.username}</p>
                  {#if profile.isPrivate}
                    <span class="inline-flex items-center gap-1.5 rounded-lg bg-yellow-500/10 border border-yellow-500/20 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-yellow-500">
                      <Papicon icon="Lock" size={10} /> Privé
                    </span>
                  {/if}
                </div>
              </div>
            </div>

            <!-- Context CTA Button -->
            {#if authStore.isAuthenticated && authStore.user?.id === userId}
              <div class="pb-2">
                <button onclick={() => router.goto('/profile')} class="group inline-flex items-center gap-2.5 rounded-lg bg-primary hover:bg-primary-hover px-8 py-4 text-[13px] font-medium text-on-primary shadow-sm shadow-primary/20 active:scale-[0.97] transition-all">
                  <Papicon icon="ShieldUser" size={16} class="transition-transform group-hover:rotate-6" />
                  Mon Espace Staff
                </button>
              </div>
            {/if}
          </div>
        </div>
      </div>

      {#if profile.isPrivate}
        <!-- Private Profile View -->
        <div class="bg-surface-container-low/40 rounded-xl border border-outline-variant/10 p-10 text-center shadow-lg">
          <div class="w-16 h-16 rounded-lg bg-yellow-500/10 border border-yellow-500/20 flex items-center justify-center mx-auto mb-6 text-yellow-500">
            <Papicon icon="Lock" size={28} />
          </div>
          <h3 class="text-xl font-semibold text-on-surface font-headline">Ce profil est privé</h3>
          <p class="mt-2 text-sm text-on-surface-variant/60 max-w-md mx-auto leading-relaxed">
            L'utilisateur a choisi de masquer ses statistiques et informations d'activité. Seuls les membres de l'équipe staff peuvent consulter ce dossier.
          </p>
        </div>
      {:else}
        <!-- Public Profile Content -->
        
        <!-- ── Metrics Section ──────────────────────────────────────── -->
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          <MetricCard 
            label="Messages" 
            value={profile.messageCount?.toLocaleString() || '0'} 
            note="Total envoyés" 
            icon="MessageSquare" 
            toneClass="bg-blue-500/10 text-blue-500 border-blue-500/20" 
          />
          <MetricCard 
            label="Vocal" 
            value={`${Math.round((profile.voiceTimeSeconds || 0) / 60)} min`} 
            note="Temps passé" 
            icon="Mic" 
            toneClass="bg-emerald-500/10 text-emerald-500 border-emerald-500/20" 
          />
          <MetricCard 
            label="Événements" 
            value={`${profile.eventParticipations?.length || 0}`} 
            note="Participations" 
            icon="Zap" 
            toneClass="bg-amber-500/10 text-amber-500 border-amber-500/20" 
          />
          <MetricCard 
            label="Ancienneté" 
            value={getDurationSince(profile.guildJoinedAt)} 
            note="Depuis l'arrivée" 
            icon="Calendar" 
            toneClass="bg-purple-500/10 text-purple-500 border-purple-500/20" 
          />
        </div>

        <!-- ── Detailed Bento Grid ────────────────────────────────── -->
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-8">
          <!-- Left Column: Biography & Metadata -->
          <div class="lg:col-span-1 space-y-6">
            <!-- Biography Card -->
            <div class="rounded-xl bg-surface-container-low/40 border border-outline-variant/10 p-8 shadow-sm relative overflow-hidden group">
              <h4 class="text-sm font-semibold text-primary uppercase tracking-widest mb-4">Biographie</h4>
              <p class="text-sm text-on-surface-variant leading-relaxed">
                {profile.bio?.trim() || 'Aucune biographie rédigée.'}
              </p>
            </div>

            <!-- Identity Card -->
            <div class="rounded-xl bg-surface-container-low/40 border border-outline-variant/10 p-8 shadow-sm relative overflow-hidden group">
              <h4 class="text-sm font-semibold text-primary uppercase tracking-widest mb-6">Dossier</h4>
              <div class="space-y-6">
                <div class="flex items-center justify-between border-b border-outline-variant/5 pb-3">
                  <span class="text-xs font-bold text-on-surface-variant/50 uppercase tracking-wider">Compte Discord créé</span>
                  <span class="text-xs font-bold text-on-surface">{formatDate(profile.accountCreatedAt)}</span>
                </div>
                <div class="flex items-center justify-between border-b border-outline-variant/5 pb-3">
                  <span class="text-xs font-bold text-on-surface-variant/50 uppercase tracking-wider">Arrivée sur le serveur</span>
                  <span class="text-xs font-bold text-on-surface">{formatDate(profile.guildJoinedAt)}</span>
                </div>
                <div class="flex items-center justify-between border-b border-outline-variant/5 pb-3">
                  <span class="text-xs font-bold text-on-surface-variant/50 uppercase tracking-wider">Dernier message</span>
                  <span class="text-xs font-bold text-on-surface">{formatTimeAgo(profile.lastSeenAt)}</span>
                </div>
                <div class="flex items-center justify-between border-b border-outline-variant/5 pb-3">
                  <span class="text-xs font-bold text-on-surface-variant/50 uppercase tracking-wider">Messages envoyés</span>
                  <span class="text-xs font-bold text-on-surface">{profile.messageCount?.toLocaleString() || 0}</span>
                </div>
                <div class="flex items-center justify-between">
                  <span class="text-xs font-bold text-on-surface-variant/50 uppercase tracking-wider">Temps en vocal</span>
                  <span class="text-xs font-bold text-on-surface">{Math.round((profile.voiceTimeSeconds || 0) / 60)} min</span>
                </div>
              </div>
            </div>

            <!-- Badges/Roles Card -->
            <div class="rounded-xl bg-surface-container-low/40 border border-outline-variant/10 p-8 shadow-sm relative overflow-hidden group">
              <h4 class="text-sm font-semibold text-primary uppercase tracking-widest mb-4">Badges & Rôles</h4>
              {#if profile.roles && profile.roles.length > 0}
                <div class="flex flex-wrap gap-2">
                  {#each profile.roles as role}
                    <span class="inline-flex items-center gap-1.5 rounded-lg bg-surface-container-high/60 border border-outline-variant/10 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">
                      {role.name}
                    </span>
                  {/each}
                </div>
              {:else}
                <p class="text-xs text-on-surface-variant/40 italic">Aucun badge de contribution répertorié.</p>
              {/if}
            </div>
          </div>

          <!-- Right Column: Events History -->
          <div class="lg:col-span-2 space-y-6">
            <div class="rounded-xl bg-surface-container-low/40 border border-outline-variant/10 p-10 shadow-sm">
              <div class="flex items-center gap-3.5 mb-8 border-b border-outline-variant/5 pb-6">
                <div class="w-12 h-12 rounded-xl bg-primary/10 border border-primary/20 text-primary flex items-center justify-center">
                  <Papicon icon="Zap" size={24} />
                </div>
                <div>
                  <h3 class="text-xl font-semibold text-on-surface font-headline leading-tight">Historique Événements</h3>
                  <p class="text-[10px] font-bold text-on-surface-variant/40 uppercase tracking-wider mt-0.5">Participations communautaires récentes</p>
                </div>
              </div>

              {#if profile.eventParticipations && profile.eventParticipations.length > 0}
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {#each profile.eventParticipations as event}
                    <div class="flex items-center justify-between p-4.5 rounded-lg bg-surface-container-high/30 border border-outline-variant/5 hover:border-primary/25 hover:bg-surface-container-high/60 transition-all">
                      <div>
                        <h4 class="text-sm font-semibold text-on-surface leading-tight truncate max-w-[180px]">{event.title}</h4>
                        <p class="text-[11px] font-bold text-primary uppercase tracking-wider mt-0.5">{event.type}</p>
                      </div>
                      <div class="text-right">
                        <span class="text-sm font-semibold text-primary">{event.score} pts</span>
                        <p class="text-[11px] font-bold text-on-surface-variant/30 uppercase tracking-wider mt-0.5">{formatDate(event.date)}</p>
                      </div>
                    </div>
                  {/each}
                </div>
              {:else}
                <div class="py-16 text-center opacity-30">
                  <Papicon icon="Zap" size={48} class="mx-auto mb-4" />
                  <p class="text-sm font-semibold uppercase tracking-widest">Aucune participation répertoriée</p>
                </div>
              {/if}
            </div>
          </div>
        </div>

        <!-- Log In Call-to-action (if not logged in) -->
        {#if !authStore.isAuthenticated}
          <div class="rounded-xl bg-linear-to-br from-indigo-950/40 via-purple-950/20 to-surface-container-low border border-outline-variant/10 p-10 text-center relative overflow-hidden shadow-sm">
            <div class="absolute -right-6 -bottom-6 w-36 h-36 bg-primary/5 rounded-full blur-none hidden pointer-events-none"></div>
            <h3 class="text-2xl font-semibold text-on-surface font-headline tracking-tight leading-none mb-3">Vous faites partie de l'équipe staff ?</h3>
            <p class="text-sm text-on-surface-variant/70 max-w-lg mx-auto mb-8 font-bold leading-relaxed">
              Connectez-vous à votre compte Discord pour accéder aux dossiers internes, statistiques détaillées d'activité, absences et outils d'administration.
            </p>
            <a href={`${API_BASE_URL}/api/auth/discord/login?returnTo=${encodeURIComponent(window.location.pathname)}`} class="inline-flex items-center gap-3 rounded-lg bg-primary hover:bg-primary-hover px-10 py-5 text-sm font-semibold uppercase tracking-widest text-on-primary shadow-sm shadow-primary/20 hover: active:scale-[0.98] transition-all">
              <Papicon icon="Lock" size={18} />
              Se connecter avec Discord
            </a>
          </div>
        {/if}
      {/if}
      
      <!-- Footer details -->
      <div class="mt-20 pt-8 border-t border-outline-variant/5 text-center">
        <p class="text-[11px] font-semibold uppercase tracking-widest text-on-surface-variant/20 italic">
          Kotbo Ecosystem • Verified Community Profile Snapshot
        </p>
      </div>

    {/if}
  </div>
</div>

<style>
  :global(.font-headline) {
    font-family: 'Outfit', 'Inter', sans-serif;
  }
</style>