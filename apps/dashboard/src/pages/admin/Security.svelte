<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from '../../lib/stores/toast.svelte';
  import { confirmDialog } from '../../lib/stores/confirmDialog.svelte';
  import { fetchGlobalAdmins, addGlobalAdmin, removeGlobalAdmin, fetchGlobalBlacklist, addGlobalBlacklist, removeGlobalBlacklist } from '../../lib/api';
  import Papicon from '../../lib/components/Papicon.svelte';
  import Skeleton from '../../lib/components/Skeleton.svelte';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';

  interface GlobalAdmin {
    userId: string;
    username: string;
    avatarUrl: string | null;
    addedBy: string;
    createdAt: string;
  }

  interface BlacklistEntry {
    userId: string;
    username: string;
    avatarUrl: string | null;
    reason: string | null;
    addedBy: string;
    createdAt: string;
  }

  // `DISCORD_` fait partie de `envPrefix` dans vite.config : la variable est
  // donc exposee au client. Un prefixe absent de cette liste - `PUBLIC_` par
  // exemple - donnerait `undefined` sans que rien ne le signale.
  const OWNER_ID = import.meta.env.DISCORD_CLIENT_OWNER_ID;

  let globalAdmins = $state<GlobalAdmin[]>([]);
  let globalBlacklist = $state<BlacklistEntry[]>([]);
  let newAdminId = $state('');
  let newBlacklistId = $state('');
  let newBlacklistReason = $state('');
  let loading = $state(true);
  let error = $state<string | null>(null);
  let adminTab = $state<'admins' | 'blacklist'>('admins');

  onMount(async () => {
    try {
      const [adminsData, blacklistData] = await Promise.all([
        fetchGlobalAdmins(),
        fetchGlobalBlacklist()
      ]);
      globalAdmins = adminsData.admins;
      globalBlacklist = blacklistData.blacklist;
    } catch (err: any) {
      error = err.message;
    } finally {
      loading = false;
    }
  });

  async function handleAddAdmin(e: Event) {
    e.preventDefault();
    if (!newAdminId.trim()) return;
    try {
      await addGlobalAdmin(newAdminId.trim());
      newAdminId = '';
      const data = await fetchGlobalAdmins();
      globalAdmins = data.admins;
      toast.success('Administrateur ajouté.');
    } catch (err: any) { toast.error(err.message); }
  }

  async function handleRemoveAdmin(userId: string, username: string) {
    if (!(await confirmDialog.danger(`Retirer l'accès global à ${username} ?`, '', 'Retirer'))) return;
    try {
      await removeGlobalAdmin(userId);
      globalAdmins = globalAdmins.filter(a => a.userId !== userId);
      toast.success(`Accès révoqué pour ${username}.`);
    } catch (err: any) { toast.error(err.message); }
  }

  async function handleAddBlacklist(e: Event) {
    e.preventDefault();
    if (!newBlacklistId.trim()) return;
    try {
      await addGlobalBlacklist(newBlacklistId.trim(), newBlacklistReason.trim());
      newBlacklistId = '';
      newBlacklistReason = '';
      const data = await fetchGlobalBlacklist();
      globalBlacklist = data.blacklist;
      toast.success('Utilisateur ajouté à la blacklist.');
    } catch (err: any) { toast.error(err.message); }
  }

  async function handleRemoveBlacklist(userId: string) {
    if (!(await confirmDialog.ask({ title: 'Retirer de la blacklist globale ?', confirmLabel: 'Retirer', variant: 'warning' }))) return;
    try {
      await removeGlobalBlacklist(userId);
      globalBlacklist = globalBlacklist.filter(b => b.userId !== userId);
      toast.success('Utilisateur retiré de la blacklist.');
    } catch (err: any) { toast.error(err.message); }
  }
</script>

<AdminShell title="Sécurité" description="Administrateurs globaux, blacklist et erreurs remontées par le bot.">
  <div class="space-y-6 pb-12 animate-in fade-in slide-in-from-bottom-3 duration-600">

    <div class="flex flex-wrap items-center justify-end gap-3">
      <!-- Stats summary -->
      {#if !loading && !error}
        <div class="flex items-center gap-2 flex-wrap">
          <div class="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-semibold">
            <Papicon icon="ShieldCheck" size={13} />
            {globalAdmins.length} admin{globalAdmins.length > 1 ? 's' : ''}
          </div>
          <div class="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-semibold">
            <Papicon icon="UserX" size={13} />
            {globalBlacklist.length} blacklisté{globalBlacklist.length > 1 ? 's' : ''}
          </div>
        </div>
      {/if}
    </div>

    <!-- Tabs -->
    <div class="flex gap-1 p-1 bg-on-surface/5 rounded-xl w-fit border border-outline-variant/10">
      <button
        onclick={() => adminTab = 'admins'}
        class="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all duration-200
 {adminTab === 'admins' ? 'bg-surface-container text-on-surface shadow-sm' : 'text-on-surface-variant/50 hover:text-on-surface'}"
      >
        <Papicon icon="ShieldCheck" size={13} />
        Administrateurs
      </button>
      <button
        onclick={() => adminTab = 'blacklist'}
        class="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all duration-200
 {adminTab === 'blacklist' ? 'bg-surface-container text-on-surface shadow-sm' : 'text-on-surface-variant/50 hover:text-on-surface'}"
      >
        <Papicon icon="UserX" size={13} />
        Blacklist
        {#if globalBlacklist.length > 0}
          <span class="px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400 text-[11px] font-semibold">{globalBlacklist.length}</span>
        {/if}
      </button>
    </div>

    {#if loading}
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {#each Array(4) as _}
          <Skeleton height="72px" class="rounded-xl" />
        {/each}
      </div>

    {:else if error}
      <div class="flex flex-col items-center justify-center py-16 gap-4 text-center bg-error/5 border border-error/15 rounded-lg">
        <div class="w-12 h-12 rounded-lg bg-error/10 border border-error/20 flex items-center justify-center text-error">
          <Papicon icon="AlertTriangle" size={22} />
        </div>
        <div>
          <p class="font-semibold text-on-surface">Erreur de chargement</p>
          <p class="text-sm text-on-surface-variant/60 mt-1">{error}</p>
        </div>
      </div>

    {:else if adminTab === 'admins'}
      <!-- Global Admins panel -->
      <div class="bg-surface-container-low/50 border border-outline-variant/10 rounded-lg p-6 space-y-5">
        <!-- Add form -->
        <div>
          <p class="text-xs font-medium text-on-surface-variant/40 mb-2">Ajouter un administrateur</p>
          <form onsubmit={handleAddAdmin} class="flex gap-2">
            <input
              type="text"
              bind:value={newAdminId}
              placeholder="ID Discord (ex: 457275321171968000)"
              class="flex-1 bg-on-surface/4 border border-outline-variant/10 rounded-xl px-4 py-2.5 text-sm text-on-surface placeholder-on-surface-variant/30 focus:outline-none focus:border-primary/30 transition-all"
              required
            />
            <button
              type="submit"
              class="px-5 py-2.5 rounded-xl bg-primary text-on-primary text-[13px] font-medium hover: transition-all shadow-md shadow-primary/20"
            >
              Ajouter
            </button>
          </form>
        </div>

        <!-- Admin list -->
        <div class="space-y-2">
          {#if globalAdmins.length === 0}
            <p class="text-sm text-center text-on-surface-variant/40 py-6 font-medium">Aucun administrateur global.</p>
          {:else}
            {#each globalAdmins as admin}
              <div class="flex items-center justify-between px-4 py-3 bg-on-surface/3 hover:bg-on-surface/5 rounded-xl border border-outline-variant/8 transition-colors group">
                <div class="flex items-center gap-3">
                  {#if admin.avatarUrl}
                    <img src={admin.avatarUrl} alt={admin.username} class="w-9 h-9 rounded-full border border-outline-variant/10 shadow-sm" />
                  {:else}
                    <div class="w-9 h-9 rounded-full bg-primary/15 border border-primary/20 flex items-center justify-center text-primary font-semibold text-sm">
                      {admin.username.charAt(0).toUpperCase()}
                    </div>
                  {/if}
                  <div>
                    <p class="font-bold text-sm text-on-surface">{admin.username}</p>
                    <p class="text-[10px] text-on-surface-variant/30 font-mono">{admin.userId}</p>
                  </div>
                </div>
                {#if admin.userId === OWNER_ID}
                  <span class="text-[11px] uppercase font-semibold tracking-widest text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1 rounded-full">Créateur</span>
                {:else}
                  <button
                    onclick={() => handleRemoveAdmin(admin.userId, admin.username)}
                    class="w-8 h-8 flex items-center justify-center rounded-lg text-on-surface-variant/30 hover:bg-red-500/10 hover:text-red-400 transition-all opacity-0 group-hover:opacity-100"
                    title="Révoquer l'accès"
                  >
                    <Papicon icon="Trash" size={14} />
                  </button>
                {/if}
              </div>
            {/each}
          {/if}
        </div>
      </div>

    {:else}
      <!-- Blacklist panel -->
      <div class="bg-surface-container-low/50 border border-outline-variant/10 rounded-lg p-6 space-y-5">
        <!-- Add form -->
        <div class="space-y-2">
          <p class="text-xs font-medium text-on-surface-variant/40">Ajouter à la blacklist</p>
          <form onsubmit={handleAddBlacklist} class="space-y-2">
            <input
              type="text"
              bind:value={newBlacklistId}
              placeholder="ID Discord à bloquer"
              class="w-full bg-on-surface/4 border border-outline-variant/10 rounded-xl px-4 py-2.5 text-sm text-on-surface placeholder-on-surface-variant/30 focus:outline-none focus:border-red-500/30 transition-all"
              required
            />
            <div class="flex gap-2">
              <input
                type="text"
                bind:value={newBlacklistReason}
                placeholder="Raison (optionnel)"
                class="flex-1 bg-on-surface/4 border border-outline-variant/10 rounded-xl px-4 py-2.5 text-sm text-on-surface placeholder-on-surface-variant/30 focus:outline-none focus:border-red-500/30 transition-all"
              />
              <button
                type="submit"
                class="px-5 py-2.5 rounded-xl bg-red-500 text-white text-[13px] font-medium hover:bg-red-600 transition-all shadow-md shadow-red-500/20"
              >
                Bannir
              </button>
            </div>
          </form>
        </div>

        <!-- Blacklist entries -->
        <div class="space-y-2">
          {#if globalBlacklist.length === 0}
            <div class="flex flex-col items-center py-8 gap-2 text-center">
              <div class="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/15 flex items-center justify-center text-emerald-400">
                <Papicon icon="ShieldCheck" size={18} />
              </div>
              <p class="text-sm text-on-surface-variant/40 font-medium">Aucun utilisateur dans la blacklist.</p>
            </div>
          {:else}
            {#each globalBlacklist as user}
              <div class="flex items-start justify-between px-4 py-3 bg-red-500/5 hover:bg-red-500/8 rounded-xl border border-red-500/10 transition-colors group">
                <div class="flex items-center gap-3">
                  {#if user.avatarUrl}
                    <img src={user.avatarUrl} alt={user.username} class="w-9 h-9 rounded-full border border-red-500/20 shadow-sm" />
                  {:else}
                    <div class="w-9 h-9 rounded-full bg-red-500/15 border border-red-500/20 flex items-center justify-center text-red-400 font-semibold text-sm">
                      {user.username.charAt(0).toUpperCase()}
                    </div>
                  {/if}
                  <div>
                    <p class="font-bold text-sm text-on-surface">{user.username}</p>
                    <p class="text-[10px] text-on-surface-variant/30 font-mono">{user.userId}</p>
                    {#if user.reason}
                      <p class="text-[10px] text-red-400/70 mt-0.5 italic">{user.reason}</p>
                    {/if}
                  </div>
                </div>
                <button
                  onclick={() => handleRemoveBlacklist(user.userId)}
                  class="w-8 h-8 flex items-center justify-center rounded-lg text-on-surface-variant/30 hover:bg-emerald-500/10 hover:text-emerald-400 transition-all opacity-0 group-hover:opacity-100 shrink-0"
                  title="Pardonner"
                >
                  <Papicon icon="Unlock" size={14} />
                </button>
              </div>
            {/each}
          {/if}
        </div>
      </div>
    {/if}
  </div>
</AdminShell>
