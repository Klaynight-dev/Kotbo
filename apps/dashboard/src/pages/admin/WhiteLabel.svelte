<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from '../../lib/stores/toast.svelte';
  import { confirmDialog } from '../../lib/stores/confirmDialog.svelte';
  import {
    fetchWhiteLabelInstances,
    createWhiteLabelInstance,
    updateWhiteLabelInstance,
    deleteWhiteLabelInstance,
    bindGuildToInstance,
    unbindGuildFromInstance,
    fetchWhiteLabelInstance,
    fetchAdminGuilds,
  } from '../../lib/api';
  import Papicon from '../../lib/components/Papicon.svelte';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';

  interface WLInstance {
    id: string;
    slug: string;
    name: string;
    enabled: boolean;
    discordClientId: string;
    dashboardUrl: string | null;
    apiPort: number | null;
    brandName: string | null;
    brandColor: string;
    brandLogoUrl: string | null;
    brandFaviconUrl: string | null;
    brandFooterText: string | null;
    ownerId: string;
    maxGuilds: number;
    guildCount: number;
    createdAt: string;
  }

  let instances = $state<WLInstance[]>([]);
  let loading = $state(true);
  let showCreateModal = $state(false);
  let detailInstance = $state<any>(null);
  let allGuilds = $state<any[]>([]);

  // Form state
  let form = $state({
    slug: '',
    name: '',
    discordToken: '',
    discordClientId: '',
    discordClientSecret: '',
    discordRedirectUri: '',
    dashboardUrl: '',
    apiPort: '',
    brandName: '',
    brandColor: '#5865F2',
    brandLogoUrl: '',
    brandFaviconUrl: '',
    brandFooterText: '',
    ownerId: '',
    maxGuilds: '1',
  });

  function resetForm() {
    form = {
      slug: '', name: '', discordToken: '', discordClientId: '',
      discordClientSecret: '', discordRedirectUri: '', dashboardUrl: '',
      apiPort: '', brandName: '', brandColor: '#5865F2', brandLogoUrl: '',
      brandFaviconUrl: '', brandFooterText: '', ownerId: '', maxGuilds: '1',
    };
  }

  async function loadInstances() {
    try {
      const data = await fetchWhiteLabelInstances();
      instances = data.instances;
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  onMount(async () => {
    await loadInstances();
    loading = false;
  });

  async function handleCreate() {
    try {
      const payload: Record<string, any> = { ...form };
      if (!payload.apiPort) delete payload.apiPort;
      if (!payload.discordRedirectUri) delete payload.discordRedirectUri;
      await createWhiteLabelInstance(payload);
      toast.success(`Instance "${form.name}" creee avec succes. Redemarrez le bot pour l'activer.`);
      showCreateModal = false;
      resetForm();
      await loadInstances();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function handleToggle(inst: WLInstance) {
    try {
      await updateWhiteLabelInstance(inst.id, { enabled: !inst.enabled });
      toast.success(`Instance "${inst.name}" ${inst.enabled ? 'desactivee' : 'activee'}.`);
      await loadInstances();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function handleDelete(inst: WLInstance) {
    if (!(await confirmDialog.danger(`Supprimer l'instance « ${inst.name} » ?`, `(${inst.slug}) Cette action est irréversible.`))) return;
    try {
      await deleteWhiteLabelInstance(inst.id);
      toast.success('Instance supprimee.');
      await loadInstances();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function openDetail(inst: WLInstance) {
    try {
      const data = await fetchWhiteLabelInstance(inst.id);
      detailInstance = data.instance;
      const guildsData = await fetchAdminGuilds();
      allGuilds = guildsData;
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function handleBindGuild(guildId: string) {
    if (!detailInstance) return;
    try {
      await bindGuildToInstance(detailInstance.id, guildId);
      toast.success('Guild rattachee.');
      await openDetail(detailInstance);
      await loadInstances();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function handleUnbindGuild(guildId: string) {
    if (!detailInstance) return;
    try {
      await unbindGuildFromInstance(detailInstance.id, guildId);
      toast.success('Guild detachee.');
      await openDetail(detailInstance);
      await loadInstances();
    } catch (err: any) {
      toast.error(err.message);
    }
  }
</script>

<AdminShell title="Marque blanche" description="Instances white-label et serveurs qui leur sont rattachés.">
  <div class="space-y-6">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-xl font-semibold text-on-surface">White-Label</h2>
        <p class="text-sm text-on-surface-variant mt-1">Gerez les instances white-label du bot</p>
      </div>
      <button
        onclick={() => { resetForm(); showCreateModal = true; }}
        class="flex items-center gap-2 px-4 py-2 bg-primary text-on-primary rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
      >
        <Papicon icon="plus" size={16} />
        Nouvelle instance
      </button>
    </div>

    {#if loading}
      <div class="flex items-center justify-center py-12">
        <div class="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full"></div>
      </div>
    {:else if instances.length === 0}
      <div class="section-card p-8 text-center">
        <Papicon icon="layers" size={32} class="text-on-surface-variant/40 mx-auto mb-3" />
        <p class="text-on-surface-variant">Aucune instance white-label configuree</p>
        <p class="text-sm text-on-surface-variant/60 mt-1">Creez une instance pour deployer le bot sous une marque differente</p>
      </div>
    {:else}
      <div class="grid gap-4">
        {#each instances as inst}
          <div class="section-card p-4">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-lg flex items-center justify-center" style="background-color: {inst.brandColor}20; border: 1px solid {inst.brandColor}40;">
                  {#if inst.brandLogoUrl}
                    <img src={inst.brandLogoUrl} alt={inst.name} class="w-6 h-6 rounded" />
                  {:else}
                    <Papicon icon="bot" size={18} style="color: {inst.brandColor}" />
                  {/if}
                </div>
                <div>
                  <div class="flex items-center gap-2">
                    <span class="font-medium text-on-surface">{inst.name}</span>
                    <span class="text-xs px-1.5 py-0.5 rounded bg-surface-container text-on-surface-variant font-mono">{inst.slug}</span>
                    {#if inst.enabled}
                      <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
                    {:else}
                      <span class="w-2 h-2 rounded-full bg-red-500"></span>
                    {/if}
                  </div>
                  <div class="flex items-center gap-3 mt-0.5 text-xs text-on-surface-variant">
                    <span>{inst.guildCount}/{inst.maxGuilds} guilds</span>
                    {#if inst.dashboardUrl}
                      <span>{inst.dashboardUrl}</span>
                    {/if}
                    {#if inst.apiPort}
                      <span>Port {inst.apiPort}</span>
                    {/if}
                  </div>
                </div>
              </div>

              <div class="flex items-center gap-2">
                <button
                  onclick={() => openDetail(inst)}
                  class="p-2 rounded-lg hover:bg-surface-container transition-colors text-on-surface-variant"
                  title="Details"
                >
                  <Papicon icon="settings" size={16} />
                </button>
                <button
                  onclick={() => handleToggle(inst)}
                  class="p-2 rounded-lg hover:bg-surface-container transition-colors"
                  class:text-emerald-500={inst.enabled}
                  class:text-red-500={!inst.enabled}
                  title={inst.enabled ? 'Desactiver' : 'Activer'}
                >
                  <Papicon icon={inst.enabled ? 'toggle-right' : 'toggle-left'} size={16} />
                </button>
                <button
                  onclick={() => handleDelete(inst)}
                  class="p-2 rounded-lg hover:bg-red-500/10 transition-colors text-red-500"
                  title="Supprimer"
                >
                  <Papicon icon="trash" size={16} />
                </button>
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Detail / Guild binding panel -->
    {#if detailInstance}
      <div class="section-card p-6 space-y-4">
        <div class="flex items-center justify-between">
          <h3 class="font-semibold text-on-surface">
            {detailInstance.name}
            <span class="text-xs font-mono text-on-surface-variant ml-2">{detailInstance.slug}</span>
          </h3>
          <button onclick={() => detailInstance = null} class="text-on-surface-variant hover:text-on-surface">
            <Papicon icon="x" size={18} />
          </button>
        </div>

        <div class="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span class="text-on-surface-variant">Client ID</span>
            <p class="font-mono text-on-surface">{detailInstance.discordClientId}</p>
          </div>
          <div>
            <span class="text-on-surface-variant">Token</span>
            <p class="font-mono text-on-surface">{detailInstance.discordToken}</p>
          </div>
          <div>
            <span class="text-on-surface-variant">Dashboard URL</span>
            <p class="text-on-surface">{detailInstance.dashboardUrl || 'Par defaut'}</p>
          </div>
          <div>
            <span class="text-on-surface-variant">Owner</span>
            <p class="font-mono text-on-surface">{detailInstance.ownerId}</p>
          </div>
        </div>

        <hr class="border-outline-variant" />

        <div>
          <h4 class="font-medium text-on-surface mb-2">Guilds rattachees ({detailInstance.guilds?.length || 0}/{detailInstance.maxGuilds})</h4>

          {#if detailInstance.guilds?.length > 0}
            <div class="space-y-2 mb-4">
              {#each detailInstance.guilds as guild}
                <div class="flex items-center justify-between px-3 py-2 bg-surface-container rounded-lg">
                  <span class="text-sm font-mono text-on-surface">{guild.id}</span>
                  <button
                    onclick={() => handleUnbindGuild(guild.id)}
                    class="text-xs text-red-500 hover:underline"
                  >
                    Detacher
                  </button>
                </div>
              {/each}
            </div>
          {/if}

          {#if (detailInstance.guilds?.length || 0) < detailInstance.maxGuilds}
            <div class="mt-2">
              <label for="bind-guild-select" class="text-xs text-on-surface-variant block mb-1">Rattacher une guild</label>
              <select
                id="bind-guild-select"
                onchange={(e) => { const v = (e.target as HTMLSelectElement).value; if (v) handleBindGuild(v); }}
                class="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded-lg text-sm text-on-surface"
              >
                <option value="">Selectionnez une guild...</option>
                {#each allGuilds.filter(g => !detailInstance.guilds?.some((bg: any) => bg.id === g.id)) as guild}
                  <option value={guild.id}>{guild.name} ({guild.id})</option>
                {/each}
              </select>
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>

  <!-- Create Modal -->
  {#if showCreateModal}
    <div class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onclick={() => showCreateModal = false} role="button" tabindex="-1" onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') showCreateModal = false; }}>
      <div class="bg-surface w-full max-w-lg rounded-2xl shadow-xl max-h-[85vh] overflow-y-auto" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1">
        <div class="p-6 space-y-4">
          <div class="flex items-center justify-between">
            <h3 class="text-lg font-semibold text-on-surface">Nouvelle instance White-Label</h3>
            <button onclick={() => showCreateModal = false} class="text-on-surface-variant hover:text-on-surface">
              <Papicon icon="x" size={18} />
            </button>
          </div>

          <div class="space-y-3">
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label for="create-slug" class="text-xs text-on-surface-variant block mb-1">Slug *</label>
                <input id="create-slug" bind:value={form.slug} placeholder="ma-commu" class="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded-lg text-sm text-on-surface" />
              </div>
              <div>
                <label for="create-name" class="text-xs text-on-surface-variant block mb-1">Nom *</label>
                <input id="create-name" bind:value={form.name} placeholder="Ma Communaute" class="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded-lg text-sm text-on-surface" />
              </div>
            </div>

            <hr class="border-outline-variant" />
            <p class="text-xs font-medium text-on-surface-variant uppercase tracking-wider">Discord App</p>

            <div>
              <label for="create-discord-token" class="text-xs text-on-surface-variant block mb-1">Bot Token *</label>
              <input id="create-discord-token" bind:value={form.discordToken} type="password" placeholder="Bot token..." class="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded-lg text-sm text-on-surface font-mono" />
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label for="create-discord-client-id" class="text-xs text-on-surface-variant block mb-1">Client ID *</label>
                <input id="create-discord-client-id" bind:value={form.discordClientId} placeholder="123456..." class="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded-lg text-sm text-on-surface font-mono" />
              </div>
              <div>
                <label for="create-discord-client-secret" class="text-xs text-on-surface-variant block mb-1">Client Secret *</label>
                <input id="create-discord-client-secret" bind:value={form.discordClientSecret} type="password" class="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded-lg text-sm text-on-surface font-mono" />
              </div>
            </div>
            <div>
              <label for="create-discord-redirect-uri" class="text-xs text-on-surface-variant block mb-1">Redirect URI (optionnel)</label>
              <input id="create-discord-redirect-uri" bind:value={form.discordRedirectUri} placeholder="https://api.commu.fr/api/auth/discord/callback" class="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded-lg text-sm text-on-surface" />
            </div>

            <hr class="border-outline-variant" />
            <p class="text-xs font-medium text-on-surface-variant uppercase tracking-wider">Dashboard</p>

            <div class="grid grid-cols-2 gap-3">
              <div>
                <label for="create-dashboard-url" class="text-xs text-on-surface-variant block mb-1">URL Dashboard</label>
                <input id="create-dashboard-url" bind:value={form.dashboardUrl} placeholder="https://panel.commu.fr" class="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded-lg text-sm text-on-surface" />
              </div>
              <div>
                <label for="create-api-port" class="text-xs text-on-surface-variant block mb-1">Port API</label>
                <input id="create-api-port" bind:value={form.apiPort} type="number" placeholder="8788" class="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded-lg text-sm text-on-surface" />
              </div>
            </div>

            <hr class="border-outline-variant" />
            <p class="text-xs font-medium text-on-surface-variant uppercase tracking-wider">Branding</p>

            <div class="grid grid-cols-2 gap-3">
              <div>
                <label for="brand-name" class="text-xs text-on-surface-variant block mb-1">Nom de marque</label>
                <input id="brand-name" bind:value={form.brandName} placeholder="Mon Bot" class="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded-lg text-sm text-on-surface" />
              </div>
              <div>
                <label for="brand-color" class="text-xs text-on-surface-variant block mb-1">Couleur primaire</label>
                <div class="flex items-center gap-2">
                  <input id="brand-color" bind:value={form.brandColor} type="color" class="w-8 h-8 rounded cursor-pointer border-0" />
                  <input bind:value={form.brandColor} placeholder="#5865F2" class="flex-1 px-3 py-2 bg-surface-container border border-outline-variant rounded-lg text-sm text-on-surface font-mono" aria-label="Couleur primaire (hex)" />
                </div>
              </div>
            </div>
            <div>
              <label for="brand-logo" class="text-xs text-on-surface-variant block mb-1">URL du logo</label>
              <input id="brand-logo" bind:value={form.brandLogoUrl} placeholder="https://..." class="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded-lg text-sm text-on-surface" />
            </div>
            <div>
              <label for="brand-footer" class="text-xs text-on-surface-variant block mb-1">Texte de footer</label>
              <input id="brand-footer" bind:value={form.brandFooterText} placeholder="Powered by..." class="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded-lg text-sm text-on-surface" />
            </div>

            <hr class="border-outline-variant" />
            <p class="text-xs font-medium text-on-surface-variant uppercase tracking-wider">Proprietaire</p>

            <div class="grid grid-cols-2 gap-3">
              <div>
                <label for="owner-id" class="text-xs text-on-surface-variant block mb-1">Discord User ID *</label>
                <input id="owner-id" bind:value={form.ownerId} placeholder="123456789..." class="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded-lg text-sm text-on-surface font-mono" />
              </div>
              <div>
                <label for="max-guilds" class="text-xs text-on-surface-variant block mb-1">Max guilds</label>
                <input id="max-guilds" bind:value={form.maxGuilds} type="number" min="1" class="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded-lg text-sm text-on-surface" />
              </div>
            </div>
          </div>

          <div class="flex justify-end gap-3 pt-2">
            <button onclick={() => showCreateModal = false} class="px-4 py-2 text-sm text-on-surface-variant hover:text-on-surface transition-colors">
              Annuler
            </button>
            <button
              onclick={handleCreate}
              disabled={!form.slug || !form.name || !form.discordToken || !form.discordClientId || !form.discordClientSecret || !form.ownerId}
              class="px-4 py-2 bg-primary text-on-primary rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              Creer l'instance
            </button>
          </div>
        </div>
      </div>
    </div>
  {/if}
</AdminShell>
