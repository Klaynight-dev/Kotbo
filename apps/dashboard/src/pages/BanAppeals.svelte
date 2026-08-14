<script lang="ts">
  import { onMount } from 'svelte';
  import { API_BASE_URL } from '../lib/api';
  import { authStore } from '../lib/stores/auth.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { toast } from '../lib/stores/toast.svelte';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import { m, dateLocale } from '../lib/i18n';

  // ── Types ──────────────────────────────────────────────────────────────────
  interface Appeal {
    id: string; userId: string; userTag: string | null; avatar: string | null;
    data: Record<string, unknown>; status: string; banReason: string | null;
    infoRequest: string | null; infoResponse: string | null;
    decidedByTag: string | null; decisionReason: string | null; decidedAt: string | null;
    dmDelivered: boolean; createdAt: string;
    messages?: any[] | null;
  }
  interface AppealDetail {
    appeal: Appeal;
    sanctions: { id: string; type: string; status: string; reason: string; createdAt: string; moderatorTag: string | null }[];
    previousAppeals: { id: string; status: string; createdAt: string; decidedAt: string | null; decisionReason: string | null }[];
  }
  interface AppealConfig {
    enabled: boolean; formId: string | null; staffChannelId: string | null;
    inviteChannelId: string | null; cooldownDays: number;
    welcomeText: string | null; acceptMessage: string | null; denyMessage: string | null;
    notifyOnBanDM?: boolean;
    appealVerification: boolean;
    appealSaveIp: boolean;
    appealSaveDevice: boolean;
    appealVerificationLevel: string;
    form?: { id: string; name: string } | null;
  }
  interface BlacklistEntry { id: string; userId: string; reason: string | null; addedByTag: string | null; createdAt: string; }

  // ── State ──────────────────────────────────────────────────────────────────
  let tab = $state<'queue' | 'history' | 'config' | 'blacklist'>('queue');
  let appeals = $state<Appeal[]>([]);
  let loading = $state(true);
  let detail = $state<AppealDetail | null>(null);
  let detailLoading = $state(false);
  let actionReason = $state('');
  let actionInProgress = $state(false);
  let config = $state<AppealConfig | null>(null);
  let configSaving = $state(false);
  let forms = $state<{ id: string; name: string }[]>([]);
  let blacklist = $state<BlacklistEntry[]>([]);
  let staffServerChannels = $state<{ id: string; name: string }[]>([]);
  let staffServerName = $state<string | null>(null);

  const channels = $derived((dashboardStore.state.discordChannels ?? []) as { id: string; name: string; type?: string }[]);
  const textChannels = $derived(channels.filter(c => c.type === undefined || c.type === 'text' || c.type === 'announcement'));
  const queue = $derived(appeals.filter(a => a.status === 'PENDING' || a.status === 'NEEDS_INFO'));
  const history = $derived(appeals.filter(a => a.status !== 'PENDING' && a.status !== 'NEEDS_INFO'));
  const publicUrl = $derived(`${window.location.origin}/appeal/${authStore.selectedGuildId}`);

  const STATUS_META: Record<string, { label: string; classes: string }> = $derived({
    PENDING: { label: m.ba_status_pending(), classes: 'bg-amber-500/10 text-amber-500 border-amber-500/30' },
    NEEDS_INFO: { label: m.ba_status_needs_info(), classes: 'bg-blue-500/10 text-blue-500 border-blue-500/30' },
    ACCEPTED: { label: m.ba_status_accepted(), classes: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30' },
    DENIED: { label: m.ba_status_denied(), classes: 'bg-rose-500/10 text-rose-500 border-rose-500/30' },
    DENIED_PERMANENT: { label: m.ba_status_denied_permanent(), classes: 'bg-rose-900/20 text-rose-400 border-rose-900/40' },
  });

  // ── API ────────────────────────────────────────────────────────────────────
  const base = () => `${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/appeals`;
  const headers = () => ({ Authorization: `Bearer ${authStore.token}`, 'Content-Type': 'application/json' });

  async function loadAppeals() {
    loading = true;
    try {
      const res = await fetch(base(), { headers: headers() });
      if (res.ok) appeals = (await res.json()).appeals ?? [];
    } catch { /* ignore */ }
    loading = false;
  }
  async function loadConfig() {
    try {
      const [cfgRes, formsRes, staffServerRes] = await Promise.all([
        fetch(`${base()}/config`, { headers: headers() }),
        fetch(`${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/custom-forms`, { headers: headers() }),
        fetch(`${API_BASE_URL}/api/dashboard/guilds/${authStore.selectedGuildId}/staff-server/channels`, { headers: headers() }),
      ]);
      if (cfgRes.ok) {
        const fetched = (await cfgRes.json()).config;
        config = fetched ? {
          ...fetched,
          appealVerification: fetched.appealVerification ?? false,
          appealSaveIp: fetched.appealSaveIp ?? true,
          appealSaveDevice: fetched.appealSaveDevice ?? true,
          appealVerificationLevel: fetched.appealVerificationLevel ?? 'HIGH',
        } : {
          enabled: false, formId: null, staffChannelId: null, inviteChannelId: null,
          cooldownDays: 30, welcomeText: null, acceptMessage: null, denyMessage: null, notifyOnBanDM: false,
          appealVerification: false, appealSaveIp: true, appealSaveDevice: true, appealVerificationLevel: 'HIGH',
        };
      }
      if (formsRes.ok) forms = ((await formsRes.json()).forms ?? []).map((f: { id: string; name: string }) => ({ id: f.id, name: f.name }));
      if (staffServerRes.ok) {
        const data = await staffServerRes.json();
        staffServerChannels = data.channels ?? [];
        staffServerName = data.staffGuildName ?? null;
      }
    } catch { /* ignore */ }
  }

  async function loadBlacklist() {
    try {
      const res = await fetch(`${base()}/blacklist`, { headers: headers() });
      if (res.ok) blacklist = (await res.json()).entries ?? [];
    } catch { /* ignore */ }
  }

  async function openDetail(appealId: string) {
    if (detail?.appeal.id === appealId) { detail = null; return; }
    detailLoading = true;
    actionReason = '';
    try {
      const res = await fetch(`${base()}/${appealId}`, { headers: headers() });
      if (res.ok) detail = await res.json();
    } catch { /* ignore */ }
    detailLoading = false;
  }

  async function decide(decision: 'ACCEPTED' | 'DENIED' | 'DENIED_PERMANENT') {
    if (!detail) return;
    if (decision !== 'ACCEPTED' && !actionReason.trim()) {
      toast.error(m.ba_reason_required());
      return;
    }
    if (decision === 'DENIED_PERMANENT' && !(await confirmDialog.ask({ title: m.ba_permanent_title(), description: m.ba_permanent_desc(), confirmLabel: m.ba_permanent_confirm(), variant: 'danger' }))) return;
    actionInProgress = true;
    try {
      const res = await fetch(`${base()}/${detail.appeal.id}/decide`, {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ decision, reason: actionReason.trim() || undefined }),
      });
      if (res.ok) {
        toast.success(decision === 'ACCEPTED' ? m.ba_accepted_toast() : m.ba_denied_toast());
        detail = null;
        await loadAppeals();
      } else {
        toast.error((await res.json()).error || m.ba_error());
      }
    } catch { toast.error(m.ba_error_network()); }
    actionInProgress = false;
  }

  async function requestInfo() {
    if (!detail || !actionReason.trim()) {
      toast.error(m.ba_ask_question());
      return;
    }
    actionInProgress = true;
    try {
      const res = await fetch(`${base()}/${detail.appeal.id}/request-info`, {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ question: actionReason.trim() }),
      });
      if (res.ok) {
        toast.success(m.ba_info_sent());
        detail = null;
        await loadAppeals();
      } else {
        toast.error((await res.json()).error || m.ba_error());
      }
    } catch { toast.error(m.ba_error_network()); }
    actionInProgress = false;
  }

  async function saveConfig(extra: Record<string, unknown> = {}) {
    if (!config) return;
    configSaving = true;
    try {
      const res = await fetch(`${base()}/config`, {
        method: 'PUT', headers: headers(),
        body: JSON.stringify({
          enabled: config.enabled,
          formId: config.formId,
          staffChannelId: config.staffChannelId,
          inviteChannelId: config.inviteChannelId,
          cooldownDays: config.cooldownDays,
          welcomeText: config.welcomeText,
          acceptMessage: config.acceptMessage,
          denyMessage: config.denyMessage,
          notifyOnBanDM: config.notifyOnBanDM,
          appealVerification: config.appealVerification,
          appealSaveIp: config.appealSaveIp,
          appealSaveDevice: config.appealSaveDevice,
          appealVerificationLevel: config.appealVerificationLevel,
          ...extra,
        }),
      });
      if (res.ok) {
        config = (await res.json()).config;
        toast.success(m.ba_config_saved());
        if (extra.createDefaultForm) await loadConfig();
      } else {
        toast.error((await res.json()).error || m.ba_error());
      }
    } catch { toast.error(m.ba_error_network()); }
    configSaving = false;
  }

  async function removeFromBlacklist(userId: string) {
    try {
      const res = await fetch(`${base()}/blacklist/${userId}`, { method: 'DELETE', headers: headers() });
      if (res.ok) {
        toast.success(m.ba_blacklist_removed());
        await loadBlacklist();
      }
    } catch { /* ignore */ }
  }

  function copyPublicUrl() {
    navigator.clipboard.writeText(publicUrl);
    toast.success(m.ba_url_copied());
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  onMount(async () => {
    await Promise.all([loadAppeals(), loadConfig(), loadBlacklist()]);
  });
</script>

<ModulePage
  title={m.ba_page_title()}
  description={m.ba_page_desc()}
  icon="gavel"
  featureKey="sanctions"
>
  {#snippet actions()}
    <button onclick={copyPublicUrl}
      class="px-4 py-2 rounded-xl bg-surface-container text-xs font-bold flex items-center gap-2 hover:bg-surface-container-high transition-colors"
      title={publicUrl}>
      <Papicon icon="link" size={14} /> {m.ba_copy_public_link()}
    </button>
  {/snippet}

  <!-- Tabs -->
  <div class="tab-group w-fit" role="tablist">
    {#each [
      { id: 'queue', label: m.ba_tab_queue({ count: queue.length }) },
      { id: 'history', label: m.ba_tab_history() },
      { id: 'config', label: m.ba_tab_config() },
      { id: 'blacklist', label: m.ba_tab_blacklist({ count: blacklist.length }) },
    ] as t}
      <button onclick={() => { tab = t.id as typeof tab; detail = null; }}
        role="tab" aria-selected={tab === t.id}
        class="tab-button {tab === t.id ? 'active' : ''}">
        {t.label}
      </button>
    {/each}
  </div>

  {#if loading}
    <div class="flex justify-center py-16">
      <div class="w-10 h-10 rounded-full border-4 border-primary/20 border-t-primary animate-spin"></div>
    </div>

  {:else if tab === 'queue' || tab === 'history'}
    {@const list = tab === 'queue' ? queue : history}
    {#if list.length === 0}
      <div class="text-center py-16 text-on-surface-variant/50 flex flex-col items-center justify-center">
        <div class="mb-4 text-on-surface-variant/30">
          <Papicon icon={tab === 'queue' ? 'check' : 'inbox'} size={48} />
        </div>
        <p class="text-sm">{tab === 'queue' ? m.ba_empty_queue() : m.ba_empty_history()}</p>
      </div>
    {:else}
      <div class="space-y-3">
        {#each list as appeal (appeal.id)}
          {@const meta = STATUS_META[appeal.status] ?? STATUS_META.PENDING}
          <div class="rounded-xl border border-outline-variant/20 bg-surface overflow-hidden">
            <button onclick={() => openDetail(appeal.id)}
              class="w-full p-4 flex items-center gap-4 hover:bg-surface-container/40 transition-colors text-left">
              {#if appeal.avatar}
                <img src={`https://cdn.discordapp.com/avatars/${appeal.userId}/${appeal.avatar}.png?size=64`} alt=""
                  class="w-10 h-10 rounded-full shrink-0" />
              {:else}
                <div class="w-10 h-10 rounded-full bg-surface-container flex items-center justify-center font-bold text-sm shrink-0">
                  {(appeal.userTag || '?').charAt(0).toUpperCase()}
                </div>
              {/if}
              <div class="flex-1 min-w-0">
                <p class="font-semibold text-on-surface text-sm truncate">{appeal.userTag || appeal.userId}</p>
                <p class="text-xs text-on-surface-variant/60 mt-0.5 truncate">
                  {formatDate(appeal.createdAt)}
                  {#if appeal.banReason} · {m.ba_ban_label()} {appeal.banReason}{/if}
                </p>
              </div>
              <span class="px-2.5 py-1 rounded-full text-[11px] font-bold border shrink-0 {meta.classes}">{meta.label}</span>
              <Papicon icon={detail?.appeal.id === appeal.id ? 'expand_less' : 'expand_more'} size={18} />
            </button>

            {#if detail?.appeal.id === appeal.id}
              <div class="border-t border-outline-variant/10 p-5 space-y-5 bg-surface-container-low/30">
                {#if detailLoading}
                  <div class="flex justify-center py-6">
                    <div class="w-7 h-7 rounded-full border-3 border-primary/20 border-t-primary animate-spin"></div>
                  </div>
                {:else}
                  <!-- Réponses du formulaire -->
                  <div>
                    <p class="text-[13px] font-medium text-on-surface-variant/50 mb-2">{m.ba_answers()}</p>
                    <div class="space-y-2">
                      {#each Object.entries(detail.appeal.data || {}) as [key, value]}
                        <div class="rounded-lg bg-surface border border-outline-variant/15 p-3">
                          <p class="text-[11px] font-semibold text-on-surface-variant/60">{key.replace(/^appeal_/, '').replace(/_/g, ' ')}</p>
                          <p class="text-sm text-on-surface mt-1 whitespace-pre-wrap break-words">{Array.isArray(value) ? value.join(', ') : String(value)}</p>
                        </div>
                      {/each}
                    </div>
                  </div>

                  {#if (detail.appeal.messages && detail.appeal.messages.length > 0) || detail.appeal.infoRequest}
                    <div class="rounded-lg bg-blue-500/5 border border-blue-500/20 p-4 space-y-4">
                      <p class="text-[11px] font-semibold text-blue-500 flex items-center gap-1.5 uppercase tracking-wider">
                        <Papicon icon="message-square" size={14} />
                        {m.ba_discussion()}
                      </p>

                      {#if detail.appeal.messages && detail.appeal.messages.length > 0}
                        <div class="space-y-3">
                          {#each detail.appeal.messages as msg}
                            <div class="p-3 rounded-lg border text-sm {msg.author === 'staff' ? 'bg-blue-500/5 border-blue-500/20' : 'bg-surface border-outline-variant/15'}">
                              <div class="flex items-center justify-between text-xs font-semibold text-on-surface-variant/60 mb-1">
                                <span>{msg.author === 'staff' ? m.ba_staff_named({ tag: msg.authorTag || m.ba_unknown() }) : m.ba_member()}</span>
                                <span>{formatDate(msg.createdAt)}</span>
                              </div>
                              <p class="whitespace-pre-wrap text-on-surface">{msg.content}</p>
                            </div>
                          {/each}
                        </div>
                      {:else if detail.appeal.infoRequest}
                        <!-- Fallback pour les anciens appels sans messages -->
                        <div class="space-y-3">
                          <div class="p-3 rounded-lg border text-sm bg-blue-500/5 border-blue-500/20">
                            <div class="flex items-center justify-between text-xs font-semibold text-on-surface-variant/60 mb-1">
                              <span>{m.ba_staff()}</span>
                            </div>
                            <p class="whitespace-pre-wrap text-on-surface">{detail.appeal.infoRequest}</p>
                          </div>
                          {#if detail.appeal.infoResponse}
                            <div class="p-3 rounded-lg border text-sm bg-surface border-outline-variant/15">
                              <div class="flex items-center justify-between text-xs font-semibold text-on-surface-variant/60 mb-1">
                                <span>{m.ba_member()}</span>
                              </div>
                              <p class="whitespace-pre-wrap text-on-surface">{detail.appeal.infoResponse}</p>
                            </div>
                          {/if}
                        </div>
                      {/if}

                      {#if detail.appeal.status === 'NEEDS_INFO' && (!detail.appeal.messages || detail.appeal.messages.length === 0 || detail.appeal.messages[detail.appeal.messages.length - 1]?.author === 'staff')}
                        <p class="text-xs text-on-surface-variant/50 mt-2 italic">{m.ba_waiting_member()}</p>
                      {/if}
                    </div>
                  {/if}

                  <!-- Contexte -->
                  <div class="grid md:grid-cols-2 gap-4">
                    <div>
                      <p class="text-[13px] font-medium text-on-surface-variant/50 mb-2">
                        {m.ba_sanction_history({ count: detail.sanctions.length })}
                      </p>
                      {#if detail.sanctions.length === 0}
                        <p class="text-xs text-on-surface-variant/50 italic">{m.ba_no_sanction()}</p>
                      {:else}
                        <div class="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                          {#each detail.sanctions as s}
                            <div class="rounded-lg bg-surface border border-outline-variant/15 px-3 py-2 text-xs">
                              <span class="font-bold">{s.type}</span>
                              <span class="text-on-surface-variant/50"> · {formatDate(s.createdAt)}{s.moderatorTag ? ` · ${s.moderatorTag}` : ''}</span>
                              <p class="text-on-surface-variant/80 mt-0.5 truncate">{s.reason}</p>
                            </div>
                          {/each}
                        </div>
                      {/if}
                    </div>
                    <div>
                      <p class="text-[13px] font-medium text-on-surface-variant/50 mb-2">
                        {m.ba_previous_appeals({ count: detail.previousAppeals.length })}
                      </p>
                      {#if detail.previousAppeals.length === 0}
                        <p class="text-xs text-on-surface-variant/50 italic">{m.ba_first_appeal()}</p>
                      {:else}
                        <div class="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                          {#each detail.previousAppeals as pa}
                            {@const pmeta = STATUS_META[pa.status] ?? STATUS_META.PENDING}
                            <div class="rounded-lg bg-surface border border-outline-variant/15 px-3 py-2 text-xs flex items-center justify-between gap-2">
                              <span class="text-on-surface-variant/70">{formatDate(pa.createdAt)}</span>
                              <span class="px-2 py-0.5 rounded-full text-[10px] font-bold border {pmeta.classes}">{pmeta.label}</span>
                            </div>
                          {/each}
                        </div>
                      {/if}
                    </div>
                  </div>

                  <!-- Décision -->
                  {#if appeal.status === 'PENDING' || appeal.status === 'NEEDS_INFO'}
                    <div class="space-y-3 pt-2 border-t border-outline-variant/10">
                      <textarea bind:value={actionReason} rows="2"
                        placeholder={m.ba_decision_placeholder()}
                        class="w-full bg-surface rounded-xl px-4 py-3 text-sm outline-none border border-outline-variant/20 focus:border-primary transition-colors resize-y"></textarea>
                      <div class="flex flex-wrap gap-2">
                        <button onclick={() => decide('ACCEPTED')} disabled={actionInProgress}
                          class="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition-colors disabled:opacity-50 flex items-center gap-1.5">
                          <Papicon icon="check" size={14} /> {m.ba_accept_unban()}
                        </button>
                        <button onclick={() => decide('DENIED')} disabled={actionInProgress}
                          class="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold transition-colors disabled:opacity-50 flex items-center gap-1.5">
                          <Papicon icon="x" size={14} /> {m.ba_deny()}
                        </button>
                        <button onclick={() => decide('DENIED_PERMANENT')} disabled={actionInProgress}
                          class="px-4 py-2 rounded-xl bg-rose-950 hover:bg-rose-900 text-rose-200 text-xs font-bold transition-colors disabled:opacity-50 flex items-center gap-1.5">
                          <Papicon icon="block" size={14} /> {m.ba_deny_permanent()}
                        </button>
                        <button onclick={requestInfo} disabled={actionInProgress}
                          class="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold transition-colors disabled:opacity-50 flex items-center gap-1.5">
                          <Papicon icon="message-square" size={14} /> {m.ba_request_info()}
                        </button>
                      </div>
                      <p class="text-[11px] text-on-surface-variant/50">
                        {m.ba_decision_hint({ days: config?.cooldownDays ?? 30 })}
                      </p>
                    </div>
                  {:else}
                    <div class="rounded-lg bg-surface border border-outline-variant/15 p-3 text-sm">
                      <p class="font-semibold text-on-surface">
                        {m.ba_decision_label({ status: STATUS_META[detail.appeal.status]?.label })}
                        {#if detail.appeal.decidedByTag}<span class="text-on-surface-variant/60 font-normal">{m.ba_decided_by({ tag: detail.appeal.decidedByTag })}</span>{/if}
                        {#if detail.appeal.decidedAt}<span class="text-on-surface-variant/60 font-normal">{m.ba_decided_at({ date: formatDate(detail.appeal.decidedAt) })}</span>{/if}
                      </p>
                      {#if detail.appeal.decisionReason}
                        <p class="text-on-surface-variant/80 mt-1">{detail.appeal.decisionReason}</p>
                      {/if}
                      <p class="text-[11px] mt-2 flex items-center gap-1.5 {detail.appeal.dmDelivered ? 'text-emerald-500' : 'text-amber-500'}">
                        {#if detail.appeal.dmDelivered}
                          <Papicon icon="check" size={12} />
                          <span>{m.ba_dm_delivered()}</span>
                        {:else}
                          <Papicon icon="warning" size={12} />
                          <span>{m.ba_dm_failed()}</span>
                        {/if}
                      </p>
                    </div>
                  {/if}
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

  {:else if tab === 'config'}
    {#if config}
      <div class="max-w-2xl space-y-5">
        <label class="flex items-center justify-between rounded-xl border border-outline-variant/20 bg-surface p-4 cursor-pointer">
          <div>
            <p class="font-semibold text-on-surface text-sm">{m.ba_enable()}</p>
            <p class="text-xs text-on-surface-variant/60 mt-0.5">{m.ba_enable_desc({ url: publicUrl })}</p>
          </div>
          <input type="checkbox" bind:checked={config.enabled} class="accent-primary w-5 h-5" />
        </label>

        <div class="rounded-xl border border-outline-variant/20 bg-surface p-4 space-y-4">
          <div>
            <p class="text-xs font-semibold text-on-surface-variant/60 mb-1.5">{m.ba_appeal_form()}</p>
            <div class="flex gap-2">
              <select bind:value={config.formId}
                class="flex-1 bg-surface-container rounded-lg px-3 py-2.5 text-sm outline-none border border-outline-variant/20">
                <option value={null}>{m.ba_none()}</option>
                {#each forms as f}
                  <option value={f.id}>{f.name}</option>
                {/each}
              </select>
              {#if !config.formId}
                <button onclick={() => saveConfig({ createDefaultForm: true })} disabled={configSaving}
                  class="px-3 py-2 rounded-lg bg-primary/10 text-primary text-xs font-bold hover:bg-primary/20 transition-colors shrink-0">
                  {m.ba_create_default_form()}
                </button>
              {/if}
            </div>
            <p class="text-[11px] text-on-surface-variant/50 mt-1.5">
              {m.ba_form_hint()}
            </p>
          </div>

          <div class="grid sm:grid-cols-2 gap-4">
            <div>
              <p class="text-xs font-semibold text-on-surface-variant/60 mb-1.5">{m.ba_staff_channel()}</p>
              <select bind:value={config.staffChannelId}
                class="w-full bg-surface-container rounded-lg px-3 py-2.5 text-sm outline-none border border-outline-variant/20">
                <option value={null}>{m.ba_none()}</option>
                {#if staffServerChannels.length > 0}
                  <optgroup label={m.ba_this_server()}>
                    {#each textChannels as c}
                      <option value={c.id}># {c.name}</option>
                    {/each}
                  </optgroup>
                  <optgroup label={staffServerName ? m.ba_linked_staff_server_named({ name: staffServerName }) : m.ba_linked_staff_server()}>
                    {#each staffServerChannels as c}
                      <option value={c.id}># {c.name}</option>
                    {/each}
                  </optgroup>
                {:else}
                  {#each textChannels as c}
                    <option value={c.id}># {c.name}</option>
                  {/each}
                {/if}
              </select>
              {#if staffServerChannels.length > 0}
                <p class="text-[11px] text-on-surface-variant/50 mt-1.5">
                  {m.ba_staff_channel_hint()}
                </p>
              {/if}
            </div>
            <div>
              <p class="text-xs font-semibold text-on-surface-variant/60 mb-1.5">{m.ba_invite_channel()}</p>
              <select bind:value={config.inviteChannelId}
                class="w-full bg-surface-container rounded-lg px-3 py-2.5 text-sm outline-none border border-outline-variant/20">
                <option value={null}>{m.ba_auto()}</option>
                {#each textChannels as c}
                  <option value={c.id}># {c.name}</option>
                {/each}
              </select>
            </div>
          </div>
          <label class="flex items-center justify-between rounded-xl border border-outline-variant/10 bg-surface-container/40 p-3.5 cursor-pointer">
            <div>
              <p class="font-semibold text-on-surface text-sm">{m.ba_dm_on_ban()}</p>
              <p class="text-xs text-on-surface-variant/60 mt-0.5">
                {m.ba_dm_on_ban_desc({ url: publicUrl })}
              </p>
            </div>
            <input type="checkbox" bind:checked={config.notifyOnBanDM} class="accent-primary w-5 h-5 shrink-0 ml-4" />
          </label>

          <!-- Appeal verification configuration -->
          <div class="space-y-4 p-4 rounded-xl border border-outline-variant/10 bg-surface-container/40">
            <label class="flex items-center justify-between cursor-pointer">
              <div>
                <p class="font-semibold text-on-surface text-sm">{m.ba_verification_required()}</p>
                <p class="text-xs text-on-surface-variant/60 mt-0.5">
                  {m.ba_verification_desc()}
                </p>
              </div>
              <input type="checkbox" bind:checked={config.appealVerification} class="accent-primary w-5 h-5 shrink-0 ml-4" />
            </label>

            {#if config.appealVerification}
              <div class="grid gap-4 grid-cols-1 sm:grid-cols-2 pt-2 border-t border-outline-variant/10">
                <label class="space-y-1.5">
                  <span class="text-xs font-semibold text-on-surface-variant/60">{m.ba_verification_level()}</span>
                  <select bind:value={config.appealVerificationLevel} class="w-full bg-surface-container rounded-lg px-3 py-2.5 text-sm outline-none border border-outline-variant/20">
                    <option value="LOW">{m.ba_level_low()}</option>
                    <option value="MEDIUM">{m.ba_level_medium()}</option>
                    <option value="HIGH">{m.ba_level_high()}</option>
                  </select>
                </label>
                <label class="flex items-center justify-between cursor-pointer pt-4">
                  <div>
                    <p class="font-semibold text-on-surface text-sm">{m.ba_save_ip()}</p>
                    <p class="text-xs text-on-surface-variant/60">
                      {m.ba_save_ip_desc()}
                    </p>
                  </div>
                  <input type="checkbox" bind:checked={config.appealSaveIp} class="accent-primary w-5 h-5 shrink-0 ml-4" />
                </label>
                <label class="flex items-center justify-between cursor-pointer pt-4">
                  <div>
                    <p class="font-semibold text-on-surface text-sm">{m.ba_save_device()}</p>
                    <p class="text-xs text-on-surface-variant/60">
                      {m.ba_save_device_desc()}
                    </p>
                  </div>
                  <input type="checkbox" bind:checked={config.appealSaveDevice} class="accent-primary w-5 h-5 shrink-0 ml-4" />
                </label>
              </div>
            {/if}
          </div>
          <div>
            <p class="text-xs font-semibold text-on-surface-variant/60 mb-1.5">
              {config.cooldownDays > 1 ? m.ba_cooldown_other({ days: config.cooldownDays }) : m.ba_cooldown_one({ days: config.cooldownDays })}
            </p>
            <input type="range" min="0" max="180" bind:value={config.cooldownDays} class="w-full accent-primary" />
          </div>

          <div>
            <p class="text-xs font-semibold text-on-surface-variant/60 mb-1.5">{m.ba_welcome_text()}</p>
            <textarea bind:value={config.welcomeText} rows="2"
              placeholder={m.ba_welcome_placeholder()}
              class="w-full bg-surface-container rounded-lg px-3 py-2.5 text-sm outline-none border border-outline-variant/20 resize-none"></textarea>
          </div>
          <div class="grid sm:grid-cols-2 gap-4">
            <div>
              <p class="text-xs font-semibold text-on-surface-variant/60 mb-1.5">{m.ba_dm_accepted()}</p>
              <textarea bind:value={config.acceptMessage} rows="3"
                placeholder={m.ba_dm_accepted_placeholder({ server: '{server}', invite: '{invite}' })}
                class="w-full bg-surface-container rounded-lg px-3 py-2.5 text-xs outline-none border border-outline-variant/20 resize-none"></textarea>
            </div>
            <div>
              <p class="text-xs font-semibold text-on-surface-variant/60 mb-1.5">{m.ba_dm_denied()}</p>
              <textarea bind:value={config.denyMessage} rows="3"
                placeholder={m.ba_dm_denied_placeholder({ server: '{server}', reason: '{reason}' })}
                class="w-full bg-surface-container rounded-lg px-3 py-2.5 text-xs outline-none border border-outline-variant/20 resize-none"></textarea>
            </div>
          </div>
          <p class="text-[11px] text-on-surface-variant/50">
            {m.ba_variables()} {'{server}'}, {'{reason}'}, {'{invite}'} {m.ba_variables_invite_only()}
          </p>
        </div>

        <div class="flex justify-end">
          <button onclick={() => saveConfig()} disabled={configSaving}
            class="px-6 py-2.5 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60">
            {configSaving ? m.ba_saving() : m.common_save()}
          </button>
        </div>
      </div>
    {/if}

  {:else if tab === 'blacklist'}
    {#if blacklist.length === 0}
      <div class="text-center py-16 text-on-surface-variant/50 flex flex-col items-center justify-center">
        <div class="mb-4 text-on-surface-variant/30">
          <Papicon icon="user" size={48} />
        </div>
        <p class="text-sm">{m.ba_no_blacklist()}</p>
      </div>
    {:else}
      <div class="space-y-2 max-w-2xl">
        {#each blacklist as entry (entry.id)}
          <div class="rounded-xl border border-outline-variant/20 bg-surface p-4 flex items-center gap-4">
            <div class="flex-1 min-w-0">
              <p class="font-semibold text-on-surface text-sm">{m.ba_blacklist_id({ id: entry.userId })}</p>
              <p class="text-xs text-on-surface-variant/60 mt-0.5 truncate">
                {entry.reason || m.ba_no_reason()} {entry.addedByTag ? m.ba_blacklist_added_by({ tag: entry.addedByTag, date: formatDate(entry.createdAt) }) : m.ba_blacklist_added({ date: formatDate(entry.createdAt) })}
              </p>
            </div>
            <button onclick={() => removeFromBlacklist(entry.userId)}
              class="px-3 py-1.5 rounded-lg bg-rose-500/10 text-rose-500 text-xs font-bold hover:bg-rose-500/20 transition-colors shrink-0">
              {m.ba_remove()}
            </button>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</ModulePage>
