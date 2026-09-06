<script lang="ts">
  import { m, dateLocale } from '../lib/i18n';
  import { memberAvatarSrc } from '../lib/discordMedia';
  import { router } from 'tinro';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { authStore } from '../lib/stores/auth.svelte';
  import {
    API_BASE_URL,
    fetchMyApiKeys,
    deleteMyApiKey,
    fetchManagerNotes,
    addManagerNote,
    deleteManagerNote,
  } from '../lib/api';
  import type { APIKey, StaffMember, TestingPeriod, StaffManagerNote } from '../lib/types';
  import MetricCard from '../lib/components/MetricCard.svelte';
  import FormInput from '../lib/components/FormInput.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import RankCardCustomizer from '../lib/components/RankCardCustomizer.svelte';
  import Chart from '../lib/components/charts/Chart.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';

  interface Props {
    userId?: string;
  }
  const { userId }: Props = $props();

  const targetUserId = $derived(userId || authStore.user?.id || '');

  let staffMember: StaffMember | null = $state(null);
  let publicProfile: any = $state(null);
  let apiKeys: APIKey[] = $state([]);
  let isBlacklisted = $state(false);
  let blacklistReason = $state('');
  let blacklistEndDate: string | null = $state(null);
  let blacklistHistory: any[] = $state([]);
  let warnings: any[] = $state([]);
  let absences: any[] = $state([]);
  let testingPeriods: TestingPeriod[] = $state([]);
  let activities: any[] = $state([]);
  let notesAbout: StaffManagerNote[] = $state([]);
  let gradeHistory: any[] = $state([]);
  let stats: any = $state(null);
  let accessibleTools: string[] = $state([]);
  let scorecard = $state<any>(null);
  let loadingScorecard = $state(false);
  
  let loading = $state(true);
  let error = $state('');
  const profileTabs = ['staff_overview', 'staff_activity', 'community_overview', 'rank_card', 'api_keys'] as const;
  let activeTab = $state('staff_overview');

  const profileBase = $derived(userId ? `/profile/${userId}` : '/profile');

  $effect(() => {
    const _path = $router.path;
    const tab = resolveTabFromUrl(profileBase, profileTabs, 'staff_overview');
    activeTab = tab;
  });

  // API Keys Form
  let showNewKeyForm = $state(false);
  let newKeyName = $state(m.pf_my_api_key());
  let copiedKeyId = $state('');
  let newKeyCreatedValue = $state('');
  let permRecruitment = $state(false);
  let permDailyAlgo = $state(true);

  // Manager Notes Form
  let newNoteContent = $state('');
  let sendingNote = $state(false);

  // Resignation
  let pendingResignation = $state<any>(null);
  let showResignationForm = $state(false);
  let resignationReason = $state('');
  let submittingResignation = $state(false);

  const isOwnProfile = $derived(targetUserId === authStore.user?.id);

  const tabs = $derived([
    ...(staffMember ? [
      { id: 'staff_overview', label: m.pf_tab_staff_overview(), icon: 'Grid' },
      { id: 'staff_activity', label: m.pf_tab_staff_activity(), icon: 'TrendingUp' }
    ] : []),
    ...(publicProfile ? [
      { id: 'community_overview', label: m.pf_tab_community(), icon: 'User' }
    ] : []),
    ...(isOwnProfile ? [
      { id: 'rank_card', label: m.pf_tab_rank_card(), icon: 'Sparkles' }
    ] : []),
    ...(staffMember && isOwnProfile ? [
      { id: 'api_keys', label: m.pf_tab_api_keys(), icon: 'Lock' }
    ] : [])
  ]);

  // Reactive effect to load profile when targetUserId changes
  $effect(() => {
    if (targetUserId) {
      loadProfile(targetUserId);
    }
  });

  // L onglet choisi dans l URL prime sur le defaut deduit du type de profil,
  // sinon un lien direct vers un onglet serait ecrase a la fin du chargement.
  function applyDefaultTab(fallback: string) {
    activeTab = resolveTabFromUrl(profileBase, profileTabs, fallback);
  }

  async function loadProfile(id: string) {
    loading = true;
    error = '';
    
    if (!authStore.token) {
      error = m.pf_not_authenticated();
      loading = false;
      return;
    }

    try {
      const guildId = authStore.selectedGuildId;
      // Fetch private staff profile details
      const res = await fetch(`${API_BASE_URL}/api/dashboard/users/${id}/profile${guildId ? `?guildId=${guildId}` : ''}`, {
        headers: { Authorization: `Bearer ${authStore.token}` }
      });

      if (res.ok) {
        const data = await res.json();
        staffMember = data.staffMember;
        publicProfile = data.publicProfile;
        apiKeys = data.apiKeys || [];
        warnings = data.warnings || [];
        absences = data.absences || [];
        testingPeriods = data.testingPeriods || [];
        activities = data.activities || [];
        notesAbout = data.notesAbout || [];
        gradeHistory = data.gradeHistory || [];
        stats = data.stats;
        isBlacklisted = data.isBlacklisted;
        blacklistReason = data.blacklistReason;
        blacklistEndDate = data.blacklistEndDate;
        blacklistHistory = data.blacklistHistory || [];
        accessibleTools = data.accessibleTools || [];
        
        // Default active tab
        if (staffMember) {
          applyDefaultTab('staff_overview');
          await loadScorecard(staffMember.guildId, id);
        } else {
          applyDefaultTab('community_overview');
        }

        // Load pending resignation if own profile
        if (data.staffMember && id === authStore.user?.id) {
          await loadPendingResignation(data.staffMember.guildId);
        }
      } else {
        // Not a staff member or unauthorized for staff details
        // Try fetching only public community profile
        const pubRes = await fetch(`${API_BASE_URL}/api/public/profile/${id}`, {
          headers: { Authorization: `Bearer ${authStore.token}` }
        });
        if (pubRes.ok) {
          publicProfile = await pubRes.json();
          staffMember = null;
          applyDefaultTab('community_overview');
        } else {
          throw new Error(m.pf_load_error());
        }
      }
    } catch (err: any) {
      console.error('Erreur lors du chargement du profil:', err);
      // Un membre sans fiche staff ni profil de serveur n'a rien a afficher ici,
      // mais sa carte de rang ne depend d'aucun des deux : sur son propre profil
      // on garde la page accessible au lieu de la remplacer par une erreur.
      if (isOwnProfile) {
        staffMember = null;
        publicProfile = null;
        applyDefaultTab('rank_card');
      } else {
        error = err.message || 'Erreur lors du chargement du profil';
      }
    } finally {
      loading = false;
    }
  }

  async function loadScorecard(guildId: string, userId: string) {
    loadingScorecard = true;
    try {
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${guildId}/staff/members/${userId}/scorecard`, {
        headers: { Authorization: `Bearer ${authStore.token}` }
      });
      if (res.ok) {
        const data = await res.json();
        scorecard = data.scorecard;
      } else {
        scorecard = null;
      }
    } catch (err) {
      console.error('Error loading staff scorecard:', err);
      scorecard = null;
    } finally {
      loadingScorecard = false;
    }
  }

  const getUserAvatar = () => {
    const own = isOwnProfile && authStore.user?.avatar
      ? `https://cdn.discordapp.com/avatars/${authStore.user.id}/${authStore.user.avatar}.png`
      : null;
    // Sans photo, l'avatar Discord par defaut est identique pour tout le monde :
    // memberAvatarSrc rend alors une initiale coloree par l'identifiant.
    return memberAvatarSrc(
      staffMember?.avatarUrl || publicProfile?.avatar || own,
      staffMember?.displayName || publicProfile?.displayName || publicProfile?.username || authStore.user?.username,
      targetUserId,
    );
  };

  const gradeIcon = (grade: string) => {
    const g = grade?.toLowerCase() || '';
    if (g.includes('fondateur') || g.includes('direction')) return 'Crown';
    if (g.includes('admin')) return 'Shield';
    if (g.includes('manager') || g.includes('responsable')) return 'ShieldCheck';
    if (g.includes('mod')) return 'ShieldHalf';
    if (g.includes('dev')) return 'Code';
    if (g.includes('helper') || g.includes('test')) return 'LifeBuoy';
    return 'Badge';
  };

  const gradeColor = (grade: string) => {
    const g = grade?.toLowerCase() || '';
    if (g.includes('fondateur') || g.includes('direction')) return 'from-amber-400 via-orange-500 to-rose-600';
    if (g.includes('admin')) return 'from-rose-500 to-orange-500';
    if (g.includes('manager') || g.includes('responsable')) return 'from-purple-500 to-indigo-600';
    if (g.includes('mod')) return 'from-blue-500 to-cyan-500';
    if (g.includes('dev')) return 'from-emerald-500 to-teal-500';
    return 'from-primary to-primary-container';
  };

  const gradeBorderColor = (grade: string) => {
    const g = grade?.toLowerCase() || '';
    if (g.includes('fondateur') || g.includes('direction')) return 'border-amber-500/20';
    if (g.includes('admin')) return 'border-rose-500/20';
    if (g.includes('manager') || g.includes('responsable')) return 'border-purple-500/20';
    if (g.includes('mod')) return 'border-blue-500/20';
    if (g.includes('dev')) return 'border-emerald-500/20';
    return 'border-primary/20';
  };

  async function createNewAPIKey() {
    if (!staffMember) return;
    
    const permissions: string[] = [];
    if (permRecruitment) permissions.push('recruitment:forms');
    if (permDailyAlgo) permissions.push('daily_algo:create_exercise');

    if (permissions.length === 0) {
      toast.error(m.pf_select_permission());
      return;
    }

    try {
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${staffMember.guildId}/api-keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authStore.token}`
        },
        body: JSON.stringify({
          name: newKeyName,
          permissions
        })
      });

      if (!res.ok) throw new Error('Erreur lors de la création de la clé API');

      const data = await res.json();
      newKeyCreatedValue = data.fullKey;
      
      // Reload keys
      const keysRes = await fetchMyApiKeys(staffMember.guildId);
      apiKeys = keysRes?.keys || [];
      showNewKeyForm = false;
      newKeyName = m.pf_my_api_key();
      permRecruitment = false;
      permDailyAlgo = true;
      toast.success(m.pf_key_created());
    } catch (err) {
      console.error(err);
      toast.error(m.pf_key_create_error());
    }
  }

  async function deleteKey(keyId: string) {
    if (!staffMember || !(await confirmDialog.danger(m.pf_revoke_key_q(), '', m.pf_revoke()))) return;
    try {
      const success = await deleteMyApiKey(keyId, staffMember.guildId);
      if (success) {
        const keysRes = await fetchMyApiKeys(staffMember.guildId);
        apiKeys = keysRes?.keys || [];
        toast.success(m.pf_key_revoked());
      }
    } catch (err) {
      console.error(err);
      toast.error(m.pf_revoke_error());
    }
  }

  function copyToClipboard(text: string, keyId: string) {
    navigator.clipboard.writeText(text);
    copiedKeyId = keyId;
    toast.success(m.pf_copied());
    setTimeout(() => { copiedKeyId = ''; }, 2000);
  }

  // Manager Notes Methods
  async function submitManagerNote() {
    if (!newNoteContent.trim() || !staffMember) return;
    sendingNote = true;
    try {
      const success = await addManagerNote(staffMember.userId, newNoteContent.trim(), staffMember.guildId);
      if (success) {
        newNoteContent = '';
        toast.success(m.pf_note_added());
        // Reload notes
        notesAbout = await fetchManagerNotes(staffMember.userId, staffMember.guildId);
      }
    } catch (err) {
      console.error(err);
      toast.error(m.pf_note_add_error());
    } finally {
      sendingNote = false;
    }
  }

  async function removeNote(noteId: string) {
    if (!staffMember || !(await confirmDialog.danger(m.pf_delete_note_q()))) return;
    try {
      const success = await deleteManagerNote(staffMember.userId, noteId, staffMember.guildId);
      if (success) {
        toast.success(m.pf_note_deleted());
        notesAbout = await fetchManagerNotes(staffMember.userId, staffMember.guildId);
      }
    } catch (err) {
      console.error(err);
      toast.error(m.home_delete_error());
    }
  }

  async function loadPendingResignation(guildId: string) {
    if (!authStore.token) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${guildId}/staff/resignations`, {
        headers: { Authorization: `Bearer ${authStore.token}` }
      });
      if (res.ok) {
        const data = await res.json();
        const myId = staffMember?.id;
        pendingResignation = (data.resignations || []).find(
          (r: any) => r.staffUserId === myId && r.status === 'PENDING'
        ) || null;
      }
    } catch (err) {
      console.error('Erreur chargement résignation:', err);
    }
  }

  async function submitResignation() {
    if (!staffMember || !resignationReason.trim()) return;
    submittingResignation = true;
    try {
      const res = await fetch(`${API_BASE_URL}/api/dashboard/guilds/${staffMember.guildId}/staff/resignations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authStore.token}`
        },
        body: JSON.stringify({ reason: resignationReason.trim() })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Erreur lors de la soumission');
      }
      const data = await res.json();
      pendingResignation = data.resignation;
      showResignationForm = false;
      resignationReason = '';
      toast.success(m.pf_resignation_submitted());
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || m.pf_submit_error());
    } finally {
      submittingResignation = false;
    }
  }

  function formatDate(date: string | Date | null | undefined) {
    if (!date) return '-';
    return new Date(date).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  }




  function formatTimeAgo(dateStr: string | null) {
    if (!dateStr) return m.pf_never();
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return m.home_rel_now();
    if (diffMins < 60) return m.pf_ago_min({ n: diffMins });
    if (diffHours < 24) return m.pf_ago_hours({ n: diffHours });
    if (diffDays === 1) return m.home_rel_yesterday();
    return m.pf_ago_days({ n: diffDays });
  }

  function getDurationSince(value: string | Date | null | undefined) {
    if (!value) return m.pf_unknown();
    const start = new Date(value);
    const now = new Date();
    let years = now.getFullYear() - start.getFullYear();
    let months = now.getMonth() - start.getMonth();
    if (months < 0) { years--; months += 12; }

    const parts: string[] = [];
    if (years > 0) parts.push(m.pf_years({ n: years }));
    if (months > 0) parts.push(m.pf_months({ n: months }));
    if (parts.length === 0) {
       const days = Math.floor((now.getTime() - start.getTime()) / 86400000);
       return days <= 0 ? m.pf_today() : m.pf_days_short({ n: days });
    }
    return parts.join(', ');
  }

  const chartData = $derived(
    activities.length > 0 ? {
      labels: activities.map(a => new Date(a.activityDate).toLocaleDateString(dateLocale(), { day: '2-digit', month: 'short' })),
      datasets: [
        {
          label: 'Messages',
          data: activities.map(a => a.messageCount),
          borderColor: 'rgb(var(--color-primary))',
          backgroundColor: 'rgba(var(--color-primary), 0.1)',
          fill: true,
          tension: 0.4,
          pointRadius: 0
        },
        {
          label: m.pf_voice_min(),
          data: activities.map(a => a.voiceMinutes || 0),
          borderColor: 'rgb(var(--color-secondary))',
          backgroundColor: 'rgba(var(--color-secondary), 0.1)',
          fill: true,
          tension: 0.4,
          pointRadius: 0
        }
      ]
    } : null
  );

  /**
   * Le volet des notes de management s'ouvre aux seuls administrateurs. Teste
   * par la negative, un serveur introuvable rendait `undefined`, different de
   * 'none' comme de 'moderator' : le volet s'affichait donc quand la liste des
   * serveurs n'etait pas encore lue. Ici, contrairement aux routes, aucune
   * raison d'etre permissif pendant l'amorcage - il vaut mieux afficher le
   * volet une fraction de seconde trop tard que trop tot.
   */
  const isRequesterManager = $derived(authStore.isAdmin);
</script>

<div class="space-y-10 animate-in fade-in slide-in-from-bottom-6 duration-1000 pb-24 font-sans">
  {#if loading}
    <div class="flex flex-col gap-10 animate-pulse w-full">
      <div class="h-64 w-full bg-surface-variant/20 rounded-xl"></div>
      <div class="flex justify-center h-16 w-full max-w-2xl mx-auto bg-surface-variant/20 rounded-full"></div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div class="h-80 bg-surface-variant/20 rounded-xl"></div>
        <div class="h-80 bg-surface-variant/20 rounded-xl"></div>
        <div class="h-80 bg-surface-variant/20 rounded-xl"></div>
      </div>
    </div>
  {:else if error}
    <div class="rounded-xl border-2 border-dashed border-rose-500/20 bg-rose-500/5 px-8 py-12 text-center max-w-2xl mx-auto">
      <div class="w-20 h-20 rounded-xl bg-rose-500/10 text-rose-500 flex items-center justify-center mx-auto mb-6">
        <Papicon icon="AlertTriangle" size={40} />
      </div>
      <h3 class="text-2xl font-semibold text-rose-700 font-headline">{m.pf_error_label()}</h3>
      <p class="mt-2 text-rose-600/70 font-bold">{error}</p>
    </div>
  {:else}

    <!-- ── Hero Banner Section ──────────────────────────────────────── -->
    <div class="relative overflow-hidden rounded-xl border border-outline-variant/10 bg-surface-container-lowest shadow-sm">
      <div class="relative h-48 md:h-64 overflow-hidden">
        {#if staffMember}
          <div class="absolute inset-0 bg-linear-to-br {gradeColor(staffMember.grade)} opacity-40 blur-none hidden scale-150"></div>
        {:else if publicProfile?.banner}
          <img src={publicProfile.banner} alt="Banner" class="w-full h-full object-cover" />
        {:else}
          <div class="absolute inset-0 bg-linear-to-br from-primary/20 via-primary/5 to-transparent blur-none hidden scale-150"></div>
        {/if}
        <div class="absolute inset-0 bg-linear-to-b from-transparent to-surface-container-lowest"></div>
        
        {#if isBlacklisted}
          <div class="absolute top-6 right-6 z-20">
            <span class="inline-flex items-center gap-2 rounded-full bg-rose-500 px-4 py-2 text-[10px] font-semibold text-white uppercase tracking-widest shadow-sm">
              <Papicon icon="Slash" size={14} />
              Compte Restreint
            </span>
          </div>
        {/if}
      </div>

      <div class="relative px-8 pb-10 -mt-20 md:-mt-24">
        <div class="flex flex-col md:flex-row items-center md:items-end justify-between gap-8 text-center md:text-left">
          <div class="flex flex-col md:flex-row items-center md:items-end gap-6">
            <!-- Avatar Frame -->
            <div class="relative shrink-0">
              {#if staffMember}
                <div class="absolute -inset-2 bg-linear-to-br {gradeColor(staffMember.grade)} rounded-xl blur-none hidden opacity-30"></div>
              {/if}
              <div class="relative w-32 h-32 md:w-40 md:h-40 rounded-xl border-[6px] border-surface-container-lowest shadow-sm overflow-hidden bg-surface-container-low">
                <img src={getUserAvatar()} alt="Avatar" class="w-full h-full object-cover" />
              </div>
            </div>

            <!-- Identity Info -->
            <div class="space-y-2 pb-2">
              <div class="flex flex-wrap items-center justify-center md:justify-start gap-3">
                <h2 class="text-lg md:text-xl font-semibold text-on-surface tracking-tighter font-headline leading-none">
                  {staffMember?.displayName || publicProfile?.displayName || publicProfile?.username || authStore.user?.username}
                </h2>
                {#if staffMember}
                  <span class="inline-flex items-center gap-2 rounded-full border-2 {gradeBorderColor(staffMember.grade)} bg-surface-container-low/60 px-4 py-2 text-xs font-medium text-on-surface-variant shadow-sm">
                    <Papicon icon={gradeIcon(staffMember.grade)} size={14} class="text-primary" />
                    {staffMember.grade}
                  </span>
                {/if}
              </div>
              <p class="text-base text-on-surface-variant/60 font-bold">
                @{publicProfile?.username || staffMember?.username || authStore.user?.username} • <span class="font-mono text-xs opacity-50">{targetUserId}</span>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ── View Tabs / Toggle ────────────────────────────────────── -->
    <div class="sticky top-6 z-40 flex justify-center">
      <div class="flex gap-1 bg-surface-container-lowest/80 p-1.5 rounded-xl border border-outline-variant/10 shadow-sm shadow-surface/10 overflow-x-auto no-scrollbar">
        {#each tabs as tab}
          <button 
            onclick={() => gotoTab(profileBase, tab.id, 'staff_overview')}
            class="tab-button {activeTab === tab.id ? 'active' : ''}"
          >
            <span class="flex items-center gap-2 pointer-events-none">
              <Papicon icon={tab.icon} size={16} class={activeTab === tab.id ? 'text-on-primary' : 'text-primary'} />
              {tab.label}
            </span>
          </button>
        {/each}
      </div>
    </div>

    <!-- ── Content Panel ────────────────────────────────── -->
    <div class="animate-in fade-in slide-in-from-bottom-4 duration-700">
      
      {#if activeTab === 'staff_overview' && staffMember}
        <!-- Staff Bento Overview -->
        <div class="space-y-8">
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <MetricCard label="Messages" value={`${stats?.totalMessages ?? 0}`} note={m.pf_total_sent()} icon="MessageSquare" toneClass="bg-primary/10 text-primary" />
            <MetricCard label={m.home_opt_voice()} value={`${Math.round((stats?.totalVoiceMinutes ?? 0))}m`} note={m.pf_time_spent()} icon="Mic" toneClass="bg-secondary/10 text-secondary" />
            <MetricCard label="Sanctions" value={`${stats?.sanctionsIssued ?? 0}`} note="Warns + blacklist" icon="Hammer" toneClass="bg-rose-500/10 text-rose-500" />
            <MetricCard label={m.pf_warnings_label()} value={`${stats?.activeWarnings ?? 0}`} note={m.pf_active_received()} icon="ShieldAlert" toneClass="bg-amber-500/10 text-amber-500" />
          </div>

          <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <!-- Career Bento Card -->
            <div class="rounded-xl bg-surface-container-low/50 p-8 border border-outline-variant/10 shadow-sm relative overflow-hidden group">
              <div class="absolute -right-12 -bottom-12 opacity-[0.03] rotate-12 pointer-events-none group- transition-transform duration-1000">
                <Papicon icon="User" size={240} />
              </div>
              
              <div class="flex items-center gap-4 mb-8">
                <div class="w-12 h-12 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                  <Papicon icon="Badge" size={24} />
                </div>
                <div>
                  <p class="text-[10px] font-semibold uppercase tracking-wider text-primary">{m.pf_staff_career()}</p>
                  <h4 class="text-xl font-semibold text-on-surface">{m.pf_identity_seniority()}</h4>
                </div>
              </div>

              <div class="grid grid-cols-2 gap-8">
                <div class="space-y-1">
                  <p class="text-xs font-medium text-on-surface-variant/40">{m.pf_staff_since()}</p>
                  <p class="text-xl font-semibold text-on-surface">{getDurationSince(staffMember.joinedStaffAt)}</p>
                  <p class="text-[10px] font-bold text-on-surface-variant/60">{formatDate(staffMember.joinedStaffAt)}</p>
                </div>
                <div class="space-y-1">
                  <p class="text-xs font-medium text-on-surface-variant/40">{m.pf_current_grade_since()}</p>
                  <p class="text-xl font-semibold text-on-surface">{getDurationSince(staffMember.currentRoleStartedAt)}</p>
                  <p class="text-[10px] font-bold text-on-surface-variant/60">{formatDate(staffMember.currentRoleStartedAt)}</p>
                </div>
                <div class="space-y-1">
                  <p class="text-xs font-medium text-on-surface-variant/40">{m.pf_tutor_status()}</p>
                  <span class="inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-[13px] font-medium {staffMember.isTutor ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20' : 'bg-on-surface/5 text-on-surface-variant/40 border border-outline-variant/10'}">
                    {staffMember.isTutor ? m.pf_active_tutor() : m.pf_not_tutor()}
                  </span>
                </div>
                <div class="space-y-1">
                  <p class="text-xs font-medium text-on-surface-variant/40">{m.pf_unique_id()}</p>
                  <p class="text-xs font-mono font-bold text-on-surface-variant truncate">{staffMember.id}</p>
                </div>
              </div>
            </div>

            <!-- Grade History Card (if visible) -->
            {#if gradeHistory.length > 0}
              <div class="rounded-xl bg-surface-container-low/50 p-8 border border-outline-variant/10 shadow-sm relative overflow-hidden">
                <h4 class="text-sm font-semibold text-primary uppercase tracking-widest mb-6">{m.pf_promotions_history()}</h4>
                <div class="space-y-4 max-h-60 overflow-y-auto pr-2">
                  {#each gradeHistory as event}
                    <div class="flex items-start gap-3 border-b border-outline-variant/5 pb-3">
                      <div class="w-2 h-2 rounded-full bg-primary mt-1.5 shrink-0"></div>
                      <div>
                        <p class="text-xs font-bold text-on-surface">{event.details}</p>
                        <p class="text-[11px] font-bold text-on-surface-variant/40 uppercase mt-0.5">{formatDate(event.dateIso)} • {m.pf_by_user_cap({ user: event.user })}</p>
                      </div>
                    </div>
                  {/each}
                </div>
              </div>
            {:else}
              <div class="rounded-xl bg-surface-container-low/50 p-8 border border-outline-variant/10 shadow-sm flex flex-col justify-center items-center text-center">
                <Papicon icon="Grid" size={40} class="text-on-surface-variant/20 mb-4" />
                <p class="text-xs font-bold text-on-surface-variant/40">{m.pf_no_grade_history()}</p>
              </div>
            {/if}
          </div>

          <!-- Disciplinary & Restrictive Panels -->
          {#if isBlacklisted}
            <div class="rounded-xl border-2 border-rose-500/20 bg-rose-500/5 p-8 flex items-start gap-6">
              <div class="w-14 h-14 rounded-xl bg-rose-500/10 text-rose-500 flex items-center justify-center shrink-0">
                <Papicon icon="AlertTriangle" size={28} />
              </div>
              <div class="space-y-1">
                <h4 class="text-lg font-semibold text-rose-700">{m.pf_restricted_account()}</h4>
                <p class="text-sm text-rose-600/80 font-bold leading-relaxed">{blacklistReason}</p>
                {#if blacklistEndDate}
                  <p class="text-xs font-medium text-rose-500 mt-2">{m.pf_restriction_end({ date: formatDate(blacklistEndDate) })}</p>
                {:else}
                  <p class="text-xs font-medium text-rose-500 mt-2">{m.pf_permanent_restriction()}</p>
                {/if}
              </div>
            </div>
          {/if}

          <!-- Warnings & Absences -->
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <!-- Warnings Panel -->
            <div class="rounded-xl bg-surface-container-low/40 border border-outline-variant/10 p-8 shadow-sm">
              <h4 class="text-sm font-semibold text-primary uppercase tracking-widest mb-6">{m.pf_warnings_received()}</h4>
              {#if warnings.length > 0}
                <div class="space-y-4">
                  {#each warnings as warn}
                    <div class="p-4 rounded-lg bg-surface-container-high/40 border border-outline-variant/5 {warn.isActive ? 'border-amber-500/10 bg-amber-500/5' : ''}">
                      <div class="flex items-center justify-between mb-2">
                        <span class="text-[13px] font-medium {warn.isActive ? 'text-amber-500' : 'text-on-surface-variant/40'}">
                          {warn.isActive ? m.pf_active() : m.pf_expired()}
                        </span>
                        <span class="text-[11px] font-bold text-on-surface-variant/40">{formatDate(warn.createdAt)}</span>
                      </div>
                      <p class="text-sm font-bold text-on-surface">{warn.reason}</p>
                      {#if warn.expiresAt}
                        <p class="text-[11px] font-bold text-on-surface-variant/40 mt-2">{m.pf_expires_on({ date: formatDate(warn.expiresAt) })}</p>
                      {/if}
                    </div>
                  {/each}
                </div>
              {:else}
                <p class="text-xs text-on-surface-variant/40 italic">{m.pf_no_warnings()}</p>
              {/if}
            </div>

            <!-- Absences Panel -->
            <div class="rounded-xl bg-surface-container-low/40 border border-outline-variant/10 p-8 shadow-sm">
              <h4 class="text-sm font-semibold text-primary uppercase tracking-widest mb-6">{m.pf_declared_absences()}</h4>
              {#if absences.length > 0}
                <div class="space-y-4 max-h-80 overflow-y-auto pr-2">
                  {#each absences as abs}
                    <div class="p-4 rounded-lg bg-surface-container-high/40 border border-outline-variant/5">
                      <div class="flex items-center justify-between mb-2">
                        <span class="text-[13px] font-medium text-primary">{abs.type}</span>
                        <span class="inline-flex items-center gap-1.5 rounded-lg px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider {abs.status === 'APPROVED' ? 'bg-emerald-500/10 text-emerald-500' : (abs.status === 'PENDING' ? 'bg-amber-500/10 text-amber-500' : 'bg-on-surface/5 text-on-surface-variant/40')}">
                          {abs.status}
                        </span>
                      </div>
                      <p class="text-sm font-bold text-on-surface">{abs.reason}</p>
                      <p class="text-[11px] font-bold text-on-surface-variant/40 mt-2">
                        {m.pf_from_to({ from: formatDate(abs.startDate), to: abs.isIndefinite ? m.pf_indefinite() : formatDate(abs.endDate) })}
                      </p>
                    </div>
                  {/each}
                </div>
              {:else}
                <p class="text-xs text-on-surface-variant/40 italic">{m.pf_no_absences()}</p>
              {/if}
            </div>
          </div>

          <!-- Testing Periods & Mentoring reports -->
          {#if testingPeriods.length > 0}
            <div class="rounded-xl bg-surface-container-low/40 border border-outline-variant/10 p-8 shadow-sm">
              <h4 class="text-sm font-semibold text-primary uppercase tracking-widest mb-6">{m.pf_testing_periods()}</h4>
              <div class="space-y-6">
                {#each testingPeriods as period}
                  <div class="p-6 rounded-xl bg-surface-container-high/30 border border-outline-variant/5 space-y-4">
                    <div class="flex items-center justify-between border-b border-outline-variant/5 pb-4">
                      <div>
                        <span class="text-xs font-medium text-on-surface-variant/40">{m.pf_objective()}</span>
                        <h5 class="text-base font-semibold text-on-surface">{period.targetGrade || m.pf_staff_grade()}</h5>
                      </div>
                      <div class="text-right">
                        <span class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-wider {period.status === 'PASSED' ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20' : (period.status === 'ONGOING' ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20' : 'bg-rose-500/10 text-rose-500 border border-rose-500/20')}">
                          {period.status === 'PASSED' ? m.pf_passed() : (period.status === 'ONGOING' ? m.home_in_progress() : m.pf_failed())}
                        </span>
                        <p class="text-[11px] font-bold text-on-surface-variant/40 mt-1">{m.pf_start_date({ date: formatDate(period.startDate) })}</p>
                      </div>
                    </div>

                    {#if period.mentor}
                      <p class="text-xs font-bold text-on-surface-variant">{m.pf_assigned_mentor()} <span class="text-on-surface font-semibold">@{period.mentor.username}</span></p>
                    {/if}

                    {#if period.reports && period.reports.length > 0}
                      <div class="space-y-3 pt-2">
                        <p class="text-xs font-medium text-on-surface-variant/40">{m.pf_mentor_reports()}</p>
                        {#each period.reports as rep}
                          <div class="p-3.5 rounded-xl bg-surface-container-low border border-outline-variant/5">
                            <div class="flex items-center justify-between mb-1.5">
                              <span class="text-[11px] font-semibold uppercase tracking-wider {rep.type === 'POSITIVE' ? 'text-emerald-500' : (rep.type === 'NEGATIVE' ? 'text-rose-500' : 'text-on-surface-variant/40')}">
                                {rep.type}
                              </span>
                              <span class="text-[11px] font-bold text-on-surface-variant/30">{formatDate(rep.createdAt)}</span>
                            </div>
                            <p class="text-xs font-medium text-on-surface-variant">{rep.content}</p>
                          </div>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          <!-- Manager Notes Pane (only visible if manager/admin) -->
          {#if isRequesterManager}
            <div class="rounded-xl bg-surface-container-low/40 border border-outline-variant/10 p-8 shadow-sm">
              <div class="flex items-center gap-3 mb-6">
                <div class="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
                  <Papicon icon="ShieldCheck" size={20} />
                </div>
                <h4 class="text-sm font-semibold text-on-surface uppercase tracking-widest">{m.pf_manager_notes()}</h4>
              </div>

              <!-- Notes List -->
              <div class="space-y-4 mb-6">
                {#each notesAbout as note}
                  <div class="p-4.5 rounded-lg bg-surface-container-high/40 border border-outline-variant/5 flex justify-between items-start gap-4">
                    <div>
                      <p class="text-sm font-bold text-on-surface">{note.content}</p>
                      <p class="text-[11px] font-bold text-on-surface-variant/40 uppercase mt-2">
                        {m.pf_posted_on({ date: formatDate(note.createdAt), author: note.author?.username || m.pf_a_manager() })}
                      </p>
                    </div>
                    <button onclick={() => removeNote(note.id)} class="p-2 rounded-lg bg-rose-500/10 text-rose-500 hover:bg-rose-500 hover:text-white transition-all">
                      <Papicon icon="Trash" size={14} />
                    </button>
                  </div>
                {:else}
                  <p class="text-xs text-on-surface-variant/40 italic">{m.pf_no_notes()}</p>
                {/each}
              </div>

              <!-- Add Note Form -->
              <div class="flex flex-col md:flex-row gap-4 items-end">
                <div class="flex-1 w-full">
                  <FormInput id="new-note" placeholder={m.pf_add_note_ph()} bind:value={newNoteContent} className="w-full" />
                </div>
                <button 
                  onclick={submitManagerNote} 
                  disabled={sendingNote || !newNoteContent.trim()}
                  class="w-full md:w-auto px-8 py-4 bg-primary text-on-primary hover:bg-primary-hover font-semibold uppercase tracking-widest text-[10px] rounded-lg shadow-lg transition-all disabled:opacity-50"
                >
                  Ajouter Note
                </button>
              </div>
            </div>
          {/if}

          <!-- ── Resignation Panel (Own profile only, staff members only) ──────── -->
          {#if isOwnProfile && staffMember}
            <div class="rounded-xl border-2 {pendingResignation ? 'border-amber-500/20 bg-amber-500/5' : 'border-rose-500/10 bg-surface-container-low/30'} p-8 shadow-sm">
              <div class="flex items-center gap-4 mb-6">
                <div class="w-12 h-12 rounded-lg {pendingResignation ? 'bg-amber-500/10 text-amber-500' : 'bg-rose-500/10 text-rose-500'} flex items-center justify-center">
                  <Papicon icon="LogOut" size={24} />
                </div>
                <div>
                  <p class="text-[10px] font-semibold uppercase tracking-wider {pendingResignation ? 'text-amber-500' : 'text-rose-500'}">Zone Sensible</p>
                  <h4 class="text-xl font-semibold text-on-surface">{m.pf_resignation()}</h4>
                </div>
              </div>

              {#if pendingResignation}
                <!-- Demande en attente -->
                <div class="p-5 rounded-lg bg-amber-500/10 border border-amber-500/20 mb-4">
                  <div class="flex items-center gap-2 mb-2">
                    <Papicon icon="Clock" size={16} class="text-amber-500" />
                    <span class="text-xs font-semibold text-amber-500 uppercase tracking-wider">Demande en attente d'approbation</span>
                  </div>
                  <p class="text-sm font-bold text-on-surface mb-1">Motif soumis :</p>
                  <p class="text-sm text-on-surface-variant leading-relaxed italic">« {pendingResignation.reason} »</p>
                  <p class="text-[11px] font-bold text-on-surface-variant/40 uppercase mt-3">{m.pf_submitted_on({ date: formatDate(pendingResignation.createdAt) })}</p>
                </div>
                <p class="text-xs font-bold text-on-surface-variant/50">
                  {m.pf_resignation_review()}
                </p>
              {:else if showResignationForm}
                <!-- Formulaire de démission -->
                <div class="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
                  <p class="text-xs font-bold text-on-surface-variant/70 leading-relaxed">
                    Une fois soumise, votre demande sera transmise aux responsables pour approbation. 
                    Veuillez expliquer clairement vos raisons.
                  </p>
                  <div>
                    <label for="resignation-reason" class="field-label">{m.pf_resignation_reason()}</label>
                    <textarea
                      id="resignation-reason"
                      bind:value={resignationReason}
                      placeholder={m.pf_resignation_ph()}
                      maxlength={500}
                      rows={4}
                      class="w-full bg-surface-container-high/60 border border-outline-variant/20 rounded-lg px-4 py-3 text-sm font-medium text-on-surface placeholder:text-on-surface-variant/30 focus:outline-none focus:border-rose-500/40 resize-none transition-colors"
                    ></textarea>
                    <p class="text-[11px] font-bold text-on-surface-variant/30 text-right mt-1">{resignationReason.length}/500</p>
                  </div>
                  <div class="flex gap-3 justify-end">
                    <button
                      onclick={() => { showResignationForm = false; resignationReason = ''; }}
                      class="px-6 py-3 rounded-lg text-xs font-medium bg-surface-container-high/60 text-on-surface-variant hover:bg-surface-container-high transition-all"
                    >
                      Annuler
                    </button>
                    <button
                      id="btn-submit-resignation"
                      onclick={submitResignation}
                      disabled={submittingResignation || !resignationReason.trim()}
                      class="px-8 py-3 rounded-lg text-xs font-medium bg-rose-500 text-white shadow-sm hover:bg-rose-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {submittingResignation ? m.pf_sending() : m.pf_submit_request()}
                    </button>
                  </div>
                </div>
              {:else}
                <!-- Bouton d'ouverture -->
                <div class="space-y-3">
                  <p class="text-xs font-bold text-on-surface-variant/60 leading-relaxed">
                    {m.pf_resignation_info()}
                  </p>
                  <button
                    id="btn-open-resignation"
                    onclick={() => showResignationForm = true}
                    class="w-full md:w-auto inline-flex items-center justify-center gap-2.5 px-8 py-3.5 rounded-lg bg-rose-500/10 text-rose-500 border border-rose-500/20 text-xs font-medium hover:bg-rose-500 hover:text-white hover:border-rose-500 hover:shadow-lg hover:shadow-rose-500/25 transition-all duration-300"
                  >
                    <Papicon icon="LogOut" size={14} />
                    {m.pf_request_resignation()}
                  </button>
                </div>
              {/if}
            </div>
          {/if}

        </div>

      {:else if activeTab === 'staff_activity' && staffMember}
        <!-- Scorecard d'Activité RH -->
        {#if scorecard}
          <div class="mb-6 space-y-6">
            <!-- Burnout warning alert -->
            {#if scorecard.burnoutRisk}
              <div class="rounded-xl border border-rose-500/20 bg-rose-500/10 p-5 flex items-start gap-3">
                <Papicon icon="ShieldAlert" size={24} class="text-rose-500 shrink-0 mt-0.5" />
                <div>
                  <h5 class="text-sm font-bold text-rose-500">{m.pf_burnout_risk()}</h5>
                  <p class="text-xs text-rose-500/80 leading-relaxed mt-1">
                    {m.pf_burnout_pre()} <strong>{scorecard.activityDropPercent}%</strong> {m.pf_burnout_post()}
                  </p>
                </div>
              </div>
            {/if}

            <div class="grid grid-cols-1 md:grid-cols-5 gap-4">
              <!-- Score global -->
              <div class="md:col-span-2 rounded-xl border border-outline-variant/10 bg-surface-container-low/30 p-6 flex flex-col items-center justify-center text-center">
                <p class="text-xs font-bold uppercase tracking-wider text-on-surface-variant/40 mb-2">Performance Globale</p>
                <div class="relative flex items-center justify-center h-28 w-28">
                  <!-- Circular progress gauge -->
                  <svg class="w-full h-full transform -rotate-90">
                    <circle cx="56" cy="56" r="48" stroke="rgba(255,255,255,0.05)" stroke-width="8" fill="transparent" />
                    <circle cx="56" cy="56" r="48" stroke="#5865F2" stroke-width="8" fill="transparent"
                      stroke-dasharray={2 * Math.PI * 48}
                      stroke-dashoffset={2 * Math.PI * 48 * (1 - scorecard.scores.overall / 100)}
                    />
                  </svg>
                  <span class="absolute text-2xl font-bold text-on-surface">{scorecard.scores.overall}%</span>
                </div>
                <p class="text-xs text-on-surface-variant/60 mt-3 font-medium">{m.pf_health_index()}</p>
              </div>

              <!-- Bento details subscores -->
              <div class="md:col-span-3 grid grid-cols-2 gap-4">
                <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 p-4">
                  <div class="flex items-center justify-between mb-1">
                    <span class="text-xs font-semibold text-on-surface-variant">Messages</span>
                    <span class="text-xs font-bold text-primary">{scorecard.scores.messages}%</span>
                  </div>
                  <div class="h-1.5 w-full bg-on-surface/5 rounded-full overflow-hidden mb-2">
                    <div class="h-full bg-primary" style="width: {scorecard.scores.messages}%"></div>
                  </div>
                  <p class="text-[10px] text-on-surface-variant/50 font-bold">{m.pf_this_week({ v: `${scorecard.messageCount} msg` })}</p>
                  <p class="text-[9px] text-on-surface-variant/30">{m.pf_last_week({ v: `${scorecard.previousMessageCount} msg` })}</p>
                </div>

                <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 p-4">
                  <div class="flex items-center justify-between mb-1">
                    <span class="text-xs font-semibold text-on-surface-variant">{m.home_opt_voice()}</span>
                    <span class="text-xs font-bold text-emerald-500">{scorecard.scores.voice}%</span>
                  </div>
                  <div class="h-1.5 w-full bg-on-surface/5 rounded-full overflow-hidden mb-2">
                    <div class="h-full bg-emerald-500" style="width: {scorecard.scores.voice}%"></div>
                  </div>
                  <p class="text-[10px] text-on-surface-variant/50 font-bold">{m.pf_this_week({ v: `${scorecard.voiceMinutes} min` })}</p>
                  <p class="text-[9px] text-on-surface-variant/30">{m.pf_last_week({ v: `${scorecard.previousVoiceMinutes} min` })}</p>
                </div>

                <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 p-4">
                  <div class="flex items-center justify-between mb-1">
                    <span class="text-xs font-semibold text-on-surface-variant">{m.home_mod_moderation_title()}</span>
                    <span class="text-xs font-bold text-amber-500">{scorecard.scores.moderation}%</span>
                  </div>
                  <div class="h-1.5 w-full bg-on-surface/5 rounded-full overflow-hidden mb-2">
                    <div class="h-full bg-amber-500" style="width: {scorecard.scores.moderation}%"></div>
                  </div>
                  <p class="text-[10px] text-on-surface-variant/50 font-bold">{m.pf_sanctions_count({ n: scorecard.sanctionsCount })}</p>
                  <p class="text-[9px] text-on-surface-variant/30">{m.pf_last_week({ v: String(scorecard.previousSanctionsCount) })}</p>
                </div>

                <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/40 p-4">
                  <div class="flex items-center justify-between mb-1">
                    <span class="text-xs font-semibold text-on-surface-variant">Support</span>
                    <span class="text-xs font-bold text-purple-500">{scorecard.scores.support}%</span>
                  </div>
                  <div class="h-1.5 w-full bg-on-surface/5 rounded-full overflow-hidden mb-2">
                    <div class="h-full bg-purple-500" style="width: {scorecard.scores.support}%"></div>
                  </div>
                  <p class="text-[10px] text-on-surface-variant/50 font-bold">{m.pf_tickets_closed({ n: scorecard.ticketsClosed })}</p>
                  <p class="text-[9px] text-on-surface-variant/30">{m.pf_last_week({ v: String(scorecard.previousTicketsClosed) })}</p>
                </div>
              </div>
            </div>
            
            <!-- Statistiques de réunions -->
            <div class="rounded-xl border border-outline-variant/10 bg-surface-container-low/30 p-4 flex items-center justify-between text-xs font-semibold text-on-surface-variant">
              <span>{m.pf_meetings_attended()} <strong class="text-on-surface">{scorecard.meetingsAttended}</strong> {m.pf_meetings_last_week({ n: scorecard.previousMeetingsAttended })}</span>
              <span class="text-on-surface-variant/40">{m.pf_realtime_update()}</span>
            </div>
          </div>
        {/if}

        <!-- Activity Chart & Metrics -->
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div class="lg:col-span-2 rounded-xl bg-surface-container-low/30 p-10 border border-outline-variant/10 shadow-sm">
            <div class="flex items-center justify-between mb-10">
              <div class="flex items-center gap-4">
                <div class="w-12 h-12 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                  <Papicon icon="TrendingUp" size={24} />
                </div>
                <div>
                  <p class="text-[10px] font-semibold uppercase tracking-wider text-primary">Performances</p>
                  <h4 class="text-2xl font-semibold text-on-surface font-headline">{m.pf_activity_trend()}</h4>
                </div>
              </div>
            </div>

            {#if chartData}
              <div class="h-[300px] w-full">
                <Chart data={chartData} height={300} />
              </div>
            {:else}
              <div class="h-[300px] flex flex-col items-center justify-center text-center">
                <Papicon icon="BarChart" size={48} class="text-on-surface-variant/20 mb-4" />
                <p class="text-sm font-bold text-on-surface-variant/40">{m.pf_not_enough_data()}</p>
              </div>
            {/if}
          </div>

          <div class="space-y-6">
            <!-- Tools Bento Grid -->
            {#if accessibleTools.length > 0}
              <div class="rounded-xl bg-surface-container-low/50 p-8 border border-outline-variant/10 shadow-sm">
                <h5 class="text-xs font-medium text-on-surface-variant/40 mb-6">Outils Accessibles</h5>
                <div class="space-y-3">
                  {#each accessibleTools as tool}
                    <div class="flex items-center gap-3 p-3.5 rounded-xl bg-surface-container-high/60 border border-outline-variant/5">
                      <div class="w-8 h-8 rounded-lg bg-primary/5 text-primary flex items-center justify-center shrink-0">
                        <Papicon icon="Gears" size={16} />
                      </div>
                      <span class="text-xs font-semibold text-on-surface-variant">{tool}</span>
                    </div>
                  {/each}
                </div>
              </div>
            {/if}

            <div class="rounded-xl bg-primary/10 p-8 text-on-primary shadow-sm shadow-primary/20">
               <Papicon icon="Sparkles" size={32} class="mb-4 opacity-50" />
               <h5 class="text-lg font-semibold tracking-tight leading-tight mb-2">{m.pf_regular_activity()}</h5>
               <p class="text-xs font-bold opacity-80 leading-relaxed">{m.pf_activity_sync()}</p>
            </div>
          </div>
        </div>

      {:else if activeTab === 'community_overview' && publicProfile}
        <!-- Community Profile View -->
        <div class="space-y-8">
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-6">
            <MetricCard label="Messages" value={publicProfile.messageCount?.toLocaleString() || '0'} note={m.pf_total_sent_pl()} icon="MessageSquare" toneClass="bg-blue-500/10 text-blue-500" />
            <MetricCard label={m.home_opt_voice()} value={`${Math.round((publicProfile.voiceTimeSeconds || 0) / 60)} min`} note={m.pf_time_spent()} icon="Mic" toneClass="bg-emerald-500/10 text-emerald-500" />
            <MetricCard label={m.home_mod_events_title()} value={`${publicProfile.eventParticipations?.length || 0}`} note="Participations" icon="Zap" toneClass="bg-amber-500/10 text-amber-500" />
            <MetricCard label={m.pf_seniority()} value={getDurationSince(publicProfile.guildJoinedAt)} note={m.pf_since_arrival()} icon="Calendar" toneClass="bg-purple-500/10 text-purple-500" />
          </div>

          <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <!-- Left column bio/identity -->
            <div class="space-y-6">
              <div class="rounded-xl bg-surface-container-low/40 border border-outline-variant/10 p-8 shadow-sm">
                <h4 class="text-xs font-semibold text-primary uppercase tracking-widest mb-4">Biographie</h4>
                <p class="text-sm text-on-surface-variant leading-relaxed">
                  {publicProfile.bio?.trim() || m.pf_no_bio()}
                </p>
              </div>

              <div class="rounded-xl bg-surface-container-low/40 border border-outline-variant/10 p-8 shadow-sm">
                <h4 class="text-xs font-semibold text-primary uppercase tracking-widest mb-6">{m.pf_account_details()}</h4>
                <div class="space-y-4">
                  <div class="flex items-center justify-between border-b border-outline-variant/5 pb-2">
                    <span class="text-xs font-bold text-on-surface-variant/40 uppercase tracking-wider">{m.pf_creation()}</span>
                    <span class="text-xs font-bold text-on-surface">{formatDate(publicProfile.accountCreatedAt)}</span>
                  </div>
                  <div class="flex items-center justify-between border-b border-outline-variant/5 pb-2">
                    <span class="text-xs font-bold text-on-surface-variant/40 uppercase tracking-wider">{m.pf_arrival()}</span>
                    <span class="text-xs font-bold text-on-surface">{formatDate(publicProfile.guildJoinedAt)}</span>
                  </div>
                  <div class="flex items-center justify-between">
                    <span class="text-xs font-bold text-on-surface-variant/40 uppercase tracking-wider">Dernier message</span>
                    <span class="text-xs font-bold text-on-surface">{formatTimeAgo(publicProfile.lastSeenAt)}</span>
                  </div>
                </div>
              </div>

              {#if publicProfile.roles && publicProfile.roles.length > 0}
                <div class="rounded-xl bg-surface-container-low/40 border border-outline-variant/10 p-8 shadow-sm">
                  <h4 class="text-xs font-semibold text-primary uppercase tracking-widest mb-4">{m.pf_roles()}</h4>
                  <div class="flex flex-wrap gap-2">
                    {#each publicProfile.roles as role}
                      <span class="inline-flex items-center gap-1.5 rounded-lg bg-surface-container-high/60 border border-outline-variant/10 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">
                        {role.name}
                      </span>
                    {/each}
                  </div>
                </div>
              {/if}
            </div>

            <!-- Right column event participations -->
            <div class="lg:col-span-2 space-y-6">
              <div class="rounded-xl bg-surface-container-low/40 border border-outline-variant/10 p-10 shadow-sm">
                <div class="flex items-center gap-3.5 mb-8 border-b border-outline-variant/5 pb-6">
                  <div class="w-12 h-12 rounded-xl bg-primary/10 border border-primary/20 text-primary flex items-center justify-center">
                    <Papicon icon="Zap" size={24} />
                  </div>
                  <div>
                    <h3 class="text-xl font-semibold text-on-surface font-headline leading-tight">{m.pf_events_history()}</h3>
                    <p class="text-[10px] font-bold text-on-surface-variant/40 uppercase tracking-wider mt-0.5">{m.pf_recent_participations()}</p>
                  </div>
                </div>

                {#if publicProfile.eventParticipations && publicProfile.eventParticipations.length > 0}
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {#each publicProfile.eventParticipations as event}
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
                    <p class="text-sm font-semibold uppercase tracking-widest">{m.pf_no_participations()}</p>
                  </div>
                {/if}
              </div>
            </div>
          </div>
        </div>

      {:else if activeTab === 'rank_card' && isOwnProfile}
        <div class="rounded-xl bg-surface-container-low/30 p-10 border border-outline-variant/10 shadow-sm">
          <RankCardCustomizer />
        </div>

      {:else if activeTab === 'api_keys' && staffMember && isOwnProfile}
        <!-- API Keys Management Panel (Own profile only) -->
        <div class="grid grid-cols-1 xl:grid-cols-[1fr_400px] gap-8">
          <div class="rounded-xl bg-surface-container-low/30 p-10 border border-outline-variant/10 shadow-sm">
            <div class="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-10">
              <div class="flex items-center gap-4">
                <div class="w-12 h-12 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                  <Papicon icon="Lock" size={24} />
                </div>
                <div>
                  <p class="text-[10px] font-semibold uppercase tracking-wider text-primary">{m.login_security()}</p>
                  <h4 class="text-2xl font-semibold text-on-surface font-headline">{m.pf_personal_api_keys()}</h4>
                </div>
              </div>
              <button 
                onclick={() => { showNewKeyForm = !showNewKeyForm; newKeyCreatedValue = ''; }}
                class="inline-flex items-center gap-2 rounded-lg px-6 py-3.5 text-xs font-medium transition-all {showNewKeyForm ? 'bg-rose-500/10 text-rose-500 border border-rose-500/20' : 'bg-primary text-on-primary hover:'}"
              >
                <Papicon icon={showNewKeyForm ? 'Cross' : 'Plus'} size={14} />
                {showNewKeyForm ? m.common_cancel() : m.pf_create_key()}
              </button>
            </div>

            {#if newKeyCreatedValue}
              <div class="mb-8 p-6 rounded-xl bg-emerald-500/5 border border-emerald-500/20 animate-in zoom-in-95 duration-500">
                <h5 class="text-sm font-semibold text-emerald-500 mb-2">{m.pf_key_generated()}</h5>
                <div class="flex items-center gap-3 bg-surface-container-high/60 px-4 py-3 rounded-lg mb-4 border border-outline-variant/10">
                  <code class="text-xs font-mono font-bold text-on-surface break-all">{newKeyCreatedValue}</code>
                  <button 
                    onclick={() => copyToClipboard(newKeyCreatedValue, 'new-key')}
                    class="p-2 rounded-lg hover:bg-surface-container-high transition-colors text-on-surface-variant/40 hover:text-primary"
                  >
                    <Papicon icon="Paper" size={16} />
                  </button>
                </div>
                <p class="text-[10px] font-bold text-rose-500">
                  {m.pf_copy_key_warning()}
                </p>
              </div>
            {/if}

            {#if showNewKeyForm}
              <div class="mb-10 p-6 rounded-xl bg-surface-container-high/40 border border-outline-variant/10 animate-in zoom-in-95 duration-500">
                <div class="flex flex-col gap-6">
                  <div class="flex flex-col md:flex-row gap-4 items-end">
                    <div class="flex-1 w-full">
                      <label for="key-name" class="field-label">{m.pf_key_name_label()}</label>
                      <FormInput id="key-name" bind:value={newKeyName} placeholder={m.pf_key_name_ph()} className="w-full" />
                    </div>
                  </div>

                  <div>
                    <span class="text-xs font-medium text-on-surface-variant/40 block mb-3 px-1">{m.pf_key_permissions()}</span>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <!-- Recruitment Checkbox -->
                      <label class="flex items-start gap-3 p-4 rounded-lg border border-outline-variant/10 bg-surface-container-low/50 hover:bg-surface-container-low cursor-pointer select-none transition-colors">
                        <input type="checkbox" bind:checked={permRecruitment} class="mt-1 accent-primary" />
                        <div>
                          <p class="text-xs font-semibold text-on-surface">Module Recrutement</p>
                          <p class="text-[10px] font-bold text-on-surface-variant/50 mt-1 leading-relaxed">
                            Lier un formulaire externe (ex: Google Forms) pour enregistrer les candidatures sur Kotbo.
                          </p>
                        </div>
                      </label>

                      <!-- Daily Algo Checkbox -->
                      <label class="flex items-start gap-3 p-4 rounded-lg border border-outline-variant/10 bg-surface-container-low/50 hover:bg-surface-container-low cursor-pointer select-none transition-colors">
                        <input type="checkbox" bind:checked={permDailyAlgo} class="mt-1 accent-primary" />
                        <div>
                          <p class="text-xs font-semibold text-on-surface">Daily Algo API</p>
                          <p class="text-[10px] font-bold text-on-surface-variant/50 mt-1 leading-relaxed">
                            {m.pf_daily_algo_perm()}
                          </p>
                        </div>
                      </label>
                    </div>
                  </div>

                  <div class="flex justify-end border-t border-outline-variant/5 pt-4">
                    <button 
                      onclick={createNewAPIKey}
                      class="w-full md:w-auto inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-500 text-white px-8 py-4 text-xs font-medium shadow-sm hover:bg-emerald-600 transition-all"
                    >
                      <Papicon icon="Check" size={14} /> {m.pf_confirm_creation()}
                    </button>
                  </div>
                </div>
              </div>
            {/if}

            {#if apiKeys.length > 0}
              <div class="grid gap-4">
                {#each apiKeys as key (key.id)}
                  <div class="group flex items-center justify-between gap-4 rounded-xl border border-outline-variant/10 bg-surface-container-low/60 p-6 transition-all hover:bg-surface-container-low hover:border-primary/20">
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-3 mb-2">
                        <span class="text-sm font-semibold text-on-surface">{key.name}</span>
                        <div class="flex gap-1">
                          {#each key.permissions as perm}
                            <span class="px-2 py-0.5 rounded-lg bg-primary/5 text-[11px] font-semibold text-primary uppercase tracking-tighter border border-primary/10">
                              {perm === 'recruitment:forms' ? 'Recrutement' : perm === 'daily_algo:create_exercise' ? 'Daily Algo' : perm}
                            </span>
                          {/each}
                        </div>
                      </div>
                      <div class="flex items-center gap-3">
                        <code class="text-xs font-mono text-on-surface-variant/60 bg-surface-container-high px-3 py-1 rounded-xl">{key.displayKey}</code>
                        <span class="text-[11px] font-bold text-on-surface-variant/40 uppercase">
                          {m.pf_used_on({ date: formatDate(key.lastUsedAt) })}
                        </span>
                      </div>
                    </div>
                    <button 
                      onclick={() => deleteKey(key.id)}
                      class="opacity-0 group-hover:opacity-100 p-3 rounded-xl bg-rose-500/10 text-rose-500 hover:bg-rose-500 hover:text-white transition-all duration-300"
                    >
                      <Papicon icon="Trash" size={18} />
                    </button>
                  </div>
                {/each}
              </div>
            {:else}
              <div class="py-20 flex flex-col items-center justify-center text-center bg-surface-container-low/20 rounded-xl border-2 border-dashed border-outline-variant/10">
                <div class="w-16 h-16 rounded-xl bg-on-surface/5 flex items-center justify-center text-on-surface-variant/20 mb-6">
                  <Papicon icon="Lock" size={32} />
                </div>
                <h5 class="text-lg font-semibold text-on-surface-variant/60">{m.pf_no_active_keys()}</h5>
                <p class="mt-1 text-sm font-bold text-on-surface-variant/30">{m.pf_generate_key_hint()}</p>
              </div>
            {/if}
          </div>

          <div class="space-y-6">
            <div class="rounded-xl bg-surface-container-low/50 p-8 border border-outline-variant/10 shadow-sm">
               <div class="flex items-center gap-3 mb-6">
                  <div class="w-10 h-10 rounded-xl bg-amber-500/10 text-amber-600 flex items-center justify-center">
                    <Papicon icon="ShieldAlert" size={20} />
                  </div>
                  <h5 class="text-sm font-semibold uppercase tracking-widest text-on-surface">{m.pf_api_key_security()}</h5>
               </div>
               <ul class="space-y-4">
                 <li class="flex gap-3 text-xs font-bold text-on-surface-variant/60 leading-relaxed">
                   <span class="text-amber-500">•</span>
                   {m.pf_revoke_hint()}
                 </li>
                 <li class="flex gap-3 text-xs font-bold text-on-surface-variant/60 leading-relaxed">
                   <span class="text-amber-500">•</span>
                   {m.pf_no_share_keys()}
                 </li>
               </ul>
            </div>
          </div>
        </div>
      {/if}

    </div>

  {/if}
</div>

<style>
  :global(.font-headline) {
    font-family: 'Outfit', 'Inter', sans-serif;
  }
</style>
