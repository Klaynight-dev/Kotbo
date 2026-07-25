<script lang="ts">
  import { toast } from '../../lib/stores/toast.svelte';
  import { fetchGdprPreview, downloadGdprExport, type GdprPreview } from '../../lib/api';
  import Papicon from '../../lib/components/Papicon.svelte';
  import AdminLayout from '../../lib/components/AdminLayout.svelte';
  import { m } from '../../lib/i18n';

  let userId = $state('');
  let loading = $state(false);
  let downloading = $state(false);
  let preview = $state<GdprPreview | null>(null);
  let error = $state<string | null>(null);
  let expanded = $state<Record<string, boolean>>({});

  const canSearch = $derived(/^\d{5,25}$/.test(userId.trim()));

  async function runPreview() {
    if (!canSearch) {
      error = m.d7_gdpr_invalid_id();
      return;
    }
    loading = true;
    error = null;
    preview = null;
    try {
      preview = await fetchGdprPreview(userId.trim());
      if (preview.meta.totalRecords === 0) {
        toast.info(m.d7_gdpr_no_data_found());
      }
    } catch (err: any) {
      error = err?.message ?? m.d7_gdpr_collect_error();
    } finally {
      loading = false;
    }
  }

  async function download() {
    if (!preview) return;
    downloading = true;
    try {
      await downloadGdprExport(preview.meta.userId);
      toast.success(m.d7_gdpr_download_success());
    } catch (err: any) {
      toast.error(err?.message ?? m.d7_gdpr_download_error());
    } finally {
      downloading = false;
    }
  }

  function toggle(key: string) {
    expanded[key] = !expanded[key];
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') runPreview();
  }
</script>

<AdminLayout>
  <div class="max-w-4xl mx-auto space-y-6">
    <!-- Header -->
    <div class="space-y-2">
      <div class="flex items-center gap-3">
        <div class="w-11 h-11 rounded-2xl bg-primary/15 border border-primary/20 flex items-center justify-center">
          <Papicon icon="ShieldCheck" size={20} class="text-primary" />
        </div>
        <div>
          <h1 class="text-xl font-bold text-on-surface leading-tight">{m.d7_gdpr_export_title()}</h1>
          <p class="text-sm text-on-surface-variant/60">{m.d7_gdpr_export_subtitle()}</p>
        </div>
      </div>
    </div>

    <!-- Search card -->
    <div class="bg-surface-container-low/50 border border-outline-variant/10 rounded-2xl p-6 space-y-4">
      <label for="gdpr-user-id" class="block text-sm font-semibold text-on-surface">{m.d7_gdpr_user_id_label()}</label>
      <div class="flex flex-col sm:flex-row gap-3">
        <input
          id="gdpr-user-id"
          bind:value={userId}
          onkeydown={onKeydown}
          placeholder={m.d7_gdpr_id_placeholder()}
          inputmode="numeric"
          class="flex-1 px-4 py-2.5 rounded-xl bg-surface-container border border-outline-variant/20 text-on-surface text-sm focus:outline-none focus:border-primary/50 transition-colors"
        />
        <button
          onclick={runPreview}
          disabled={!canSearch || loading}
          class="px-5 py-2.5 rounded-xl bg-primary text-on-primary text-sm font-bold flex items-center justify-center gap-2 hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        >
          {#if loading}
            <span class="w-4 h-4 border-2 border-on-primary/30 border-t-on-primary rounded-full animate-spin"></span>
            {m.d7_gdpr_collecting()}
          {:else}
            <Papicon icon="Search" size={15} />
            {m.d7_search()}
          {/if}
        </button>
      </div>
      <p class="text-xs text-on-surface-variant/40">
        {m.d7_gdpr_collect_hint()}
      </p>
    </div>

    {#if error}
      <div class="flex items-center gap-3 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
        <Papicon icon="AlertTriangle" size={16} />
        {error}
      </div>
    {/if}

    <!-- Results -->
    {#if preview}
      <div class="space-y-5 animate-in fade-in duration-300">
        <!-- Summary + download -->
        <div class="bg-surface-container-low/50 border border-outline-variant/10 rounded-2xl p-6">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div class="flex items-center gap-4">
              {#if preview.identity.discordUser?.avatarURL}
                <img src={String(preview.identity.discordUser.avatarURL)} alt="" class="w-12 h-12 rounded-full" />
              {:else}
                <div class="w-12 h-12 rounded-full bg-on-surface/5 flex items-center justify-center">
                  <Papicon icon="User" size={20} class="text-on-surface-variant/40" />
                </div>
              {/if}
              <div>
                <p class="font-bold text-on-surface">
                  {preview.meta.username ?? m.d7_gdpr_unknown_user()}
                  {#if preview.meta.globalName}<span class="text-on-surface-variant/50 font-normal"> · {preview.meta.globalName}</span>{/if}
                </p>
                <p class="text-xs text-on-surface-variant/50 font-mono">{preview.meta.userId}</p>
              </div>
            </div>
            <button
              onclick={download}
              disabled={downloading}
              class="px-5 py-2.5 rounded-xl bg-emerald-500 text-white text-sm font-bold flex items-center justify-center gap-2 hover:bg-emerald-600 disabled:opacity-40 transition-all shrink-0"
            >
              {#if downloading}
                <span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                {m.d7_gdpr_generating()}
              {:else}
                <Papicon icon="Download" size={15} />
                {m.d7_gdpr_download_zip()}
              {/if}
            </button>
          </div>

          <div class="grid grid-cols-3 gap-3 mt-5">
            <div class="rounded-xl bg-on-surface/3 border border-outline-variant/10 px-4 py-3">
              <p class="text-2xl font-bold text-on-surface">{preview.meta.totalRecords}</p>
              <p class="text-[11px] uppercase tracking-wider text-on-surface-variant/40 font-semibold">{m.d7_gdpr_records()}</p>
            </div>
            <div class="rounded-xl bg-on-surface/3 border border-outline-variant/10 px-4 py-3">
              <p class="text-2xl font-bold text-on-surface">{preview.categories.length}</p>
              <p class="text-[11px] uppercase tracking-wider text-on-surface-variant/40 font-semibold">{m.d7_gdpr_categories()}</p>
            </div>
            <div class="rounded-xl bg-on-surface/3 border border-outline-variant/10 px-4 py-3">
              <p class="text-2xl font-bold text-on-surface">{preview.meta.guildCount}</p>
              <p class="text-[11px] uppercase tracking-wider text-on-surface-variant/40 font-semibold">{m.d7_gdpr_servers()}</p>
            </div>
          </div>

          {#if preview.identity.guilds.length}
            <div class="mt-4 flex flex-wrap gap-2">
              {#each preview.identity.guilds as g}
                <span class="text-xs px-2.5 py-1 rounded-lg bg-on-surface/5 border border-outline-variant/10 text-on-surface-variant/70">{g.name}</span>
              {/each}
            </div>
          {/if}

          {#if preview.meta.errors.length}
            <div class="mt-4 px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs">
              <p class="font-semibold mb-1">{m.d7_gdpr_collect_warnings({ count: preview.meta.errors.length })}</p>
              <ul class="list-disc list-inside space-y-0.5 opacity-80">
                {#each preview.meta.errors as e}<li>{e}</li>{/each}
              </ul>
            </div>
          {/if}
        </div>

        <!-- Categories breakdown -->
        {#if preview.categories.length}
          <div class="space-y-2">
            {#each preview.categories as cat}
              <div class="bg-surface-container-low/50 border border-outline-variant/10 rounded-2xl overflow-hidden">
                <button
                  onclick={() => toggle(cat.key)}
                  class="w-full flex items-center justify-between gap-3 px-5 py-4 hover:bg-on-surface/3 transition-colors text-left"
                >
                  <div class="min-w-0">
                    <p class="font-semibold text-on-surface flex items-center gap-2">
                      {cat.label}
                      <span class="text-xs px-2 py-0.5 rounded-full bg-primary/15 text-primary font-bold">{cat.count}</span>
                    </p>
                    <p class="text-xs text-on-surface-variant/50 truncate">{cat.description}</p>
                  </div>
                  <Papicon icon={expanded[cat.key] ? 'ChevronDown' : 'ChevronRight'} size={16} class="text-on-surface-variant/40 shrink-0" />
                </button>
                {#if expanded[cat.key]}
                  <div class="px-5 pb-4 space-y-1.5 border-t border-outline-variant/10 pt-3">
                    {#each cat.tables as t}
                      <div class="flex items-center justify-between text-sm">
                        <span class="text-on-surface-variant/70">{t.label}</span>
                        <span class="font-mono text-on-surface-variant/50">{t.count}</span>
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {:else}
          <div class="text-center py-10 text-on-surface-variant/40 text-sm">
            <Papicon icon="Inbox" size={28} class="mx-auto mb-2 opacity-50" />
            {m.d7_gdpr_no_data_retained()}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</AdminLayout>
