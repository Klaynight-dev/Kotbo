<script lang="ts">
  import { onMount } from 'svelte';
  import { m } from '../lib/i18n';
  import Papicon from '../lib/components/Papicon.svelte';
  import { fetchAdminLockRequests, decideAdminLockRequest as decideRequestApi } from '../lib/api';
  import { confirmDialog } from '../lib/stores/confirmDialog.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';

  interface AdminLockRequest {
    id: string;
    type: 'ROLE_CREATE' | 'ROLE_PERMISSION_EDIT' | 'MEMBER_ROLE_GRANT';
    status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
    targetRoleId: string | null;
    targetRoleName: string | null;
    targetMemberId: string | null;
    requestedPermissionBits: string;
    requestedByUserId: string;
    requestedByTag: string | null;
    requestedVia: string;
    requestReason: string | null;
    decidedByTag: string | null;
    decisionReason: string | null;
    decidedAt: string | null;
    createdAt: string;
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let tab = $state<'queue' | 'history'>('queue');
  let requests = $state<AdminLockRequest[]>([]);
  let loading = $state(true);
  let openId = $state<string | null>(null);
  let actionReason = $state('');
  let actionInProgress = $state(false);

  const queue = $derived(requests.filter(r => r.status === 'PENDING'));
  const history = $derived(requests.filter(r => r.status !== 'PENDING'));

  const TYPE_LABELS: Record<string, string> = {
    ROLE_CREATE: m.e7_alr_type_role_create(),
    ROLE_PERMISSION_EDIT: m.e7_alr_type_role_permission_edit(),
    MEMBER_ROLE_GRANT: m.e7_alr_type_member_role_grant(),
  };

  const STATUS_META: Record<string, { label: string; classes: string }> = {
    PENDING: { label: m.e7_alr_status_pending(), classes: 'bg-amber-500/10 text-amber-500 border-amber-500/30' },
    APPROVED: { label: m.e7_alr_status_approved(), classes: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30' },
    REJECTED: { label: m.e7_alr_status_rejected(), classes: 'bg-rose-500/10 text-rose-500 border-rose-500/30' },
    EXPIRED: { label: m.e7_alr_status_expired(), classes: 'bg-rose-900/20 text-rose-400 border-rose-900/40' },
  };

  // ── API ────────────────────────────────────────────────────────────────────
  async function loadRequests() {
    loading = true;
    try {
      const res = await fetchAdminLockRequests();
      requests = res?.requests ?? [];
    } catch { /* toast déjà affiché par dashboardRequest */ }
    loading = false;
  }

  function toggleOpen(id: string) {
    openId = openId === id ? null : id;
    actionReason = '';
  }

  async function decide(request: AdminLockRequest, decision: 'APPROVED' | 'REJECTED') {
    if (decision === 'REJECTED' && !actionReason.trim() && !(await confirmDialog.ask({ title: m.e7_alr_confirm_reject_title(), description: m.e7_alr_confirm_reject_desc(), confirmLabel: m.e7_alr_confirm_reject_label(), variant: 'warning' }))) return;
    actionInProgress = true;
    try {
      await decideRequestApi(request.id, { decision, reason: actionReason.trim() || undefined });
      openId = null;
      await loadRequests();
    } catch { /* toast déjà affiché */ }
    actionInProgress = false;
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function requesterLabel(r: AdminLockRequest): string {
    if (r.requestedByUserId === 'mcp') return m.e7_alr_requester_mcp();
    return r.requestedByTag ? `${r.requestedByTag} (${r.requestedByUserId})` : r.requestedByUserId;
  }

  function targetLabel(r: AdminLockRequest): string {
    if (r.type === 'MEMBER_ROLE_GRANT') return m.e7_alr_target_member_grant({ role: r.targetRoleName ?? r.targetRoleId ?? '', member: r.targetMemberId ?? '' });
    if (r.type === 'ROLE_PERMISSION_EDIT') return m.e7_alr_target_permission_edit({ role: r.targetRoleName ?? r.targetRoleId ?? '' });
    return m.e7_alr_target_role_create({ role: r.targetRoleName ?? '?' });
  }

  onMount(async () => {
    await loadRequests();
  });
</script>

<ModulePage
  title={m.e7_alr_page_title()}
  description={m.e7_alr_page_description()}
  icon="lock"
  featureKey="automod"
>

  <!-- Tabs -->
  <div class="tab-group w-fit" role="tablist">
    {#each [
      { id: 'queue', label: m.e7_alr_tab_queue({ count: queue.length }) },
      { id: 'history', label: m.e7_alr_tab_history() },
    ] as t}
      <button onclick={() => { tab = t.id as typeof tab; openId = null; }}
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
  {:else}
    {@const list = tab === 'queue' ? queue : history}
    {#if list.length === 0}
      <div class="text-center py-16 text-on-surface-variant/50 flex flex-col items-center justify-center">
        <div class="mb-4 text-on-surface-variant/30">
          <Papicon icon={tab === 'queue' ? 'check' : 'inbox'} size={48} />
        </div>
        <p class="text-sm">{tab === 'queue' ? m.e7_alr_empty_queue() : m.e7_alr_empty_history()}</p>
      </div>
    {:else}
      <div class="space-y-3">
        {#each list as request (request.id)}
          {@const meta = STATUS_META[request.status] ?? STATUS_META.PENDING}
          <div class="rounded-xl border border-outline-variant/20 bg-surface overflow-hidden">
            <button onclick={() => toggleOpen(request.id)}
              class="w-full p-4 flex items-center gap-4 hover:bg-surface-container/40 transition-colors text-left">
              <div class="w-10 h-10 rounded-full bg-rose-500/10 text-rose-500 flex items-center justify-center shrink-0">
                <Papicon icon="lock" size={18} />
              </div>
              <div class="flex-1 min-w-0">
                <p class="font-semibold text-on-surface text-sm truncate">{TYPE_LABELS[request.type] ?? request.type} — {targetLabel(request)}</p>
                <p class="text-xs text-on-surface-variant/60 mt-0.5 truncate">
                  {m.e7_alr_meta_created({ date: formatDate(request.createdAt), requester: requesterLabel(request), via: request.requestedVia })}
                </p>
              </div>
              <span class="px-2.5 py-1 rounded-full text-[11px] font-bold border shrink-0 {meta.classes}">{meta.label}</span>
              <Papicon icon={openId === request.id ? 'expand_less' : 'expand_more'} size={18} />
            </button>

            {#if openId === request.id}
              <div class="border-t border-outline-variant/10 p-5 space-y-4 bg-surface-container-low/30">
                <div class="rounded-lg bg-surface border border-outline-variant/15 p-3 text-sm space-y-1">
                  <p><span class="font-semibold text-on-surface-variant/60">{m.e7_alr_field_type()}</span> {TYPE_LABELS[request.type] ?? request.type}</p>
                  <p><span class="font-semibold text-on-surface-variant/60">{m.e7_alr_field_target()}</span> {targetLabel(request)}</p>
                  <p><span class="font-semibold text-on-surface-variant/60">{m.e7_alr_field_requested_by()}</span> {requesterLabel(request)}</p>
                  <p><span class="font-semibold text-on-surface-variant/60">{m.e7_alr_field_via()}</span> {request.requestedVia}</p>
                  {#if request.requestReason}
                    <p><span class="font-semibold text-on-surface-variant/60">{m.e7_alr_field_reason()}</span> {request.requestReason}</p>
                  {/if}
                </div>

                {#if request.status === 'PENDING'}
                  <div class="space-y-3 pt-2 border-t border-outline-variant/10">
                    <textarea bind:value={actionReason} rows="2"
                      placeholder={m.e7_alr_reject_placeholder()}
                      class="w-full bg-surface rounded-xl px-4 py-3 text-sm outline-none border border-outline-variant/20 focus:border-primary transition-colors resize-y"></textarea>
                    <div class="flex flex-wrap gap-2">
                      <button onclick={() => decide(request, 'APPROVED')} disabled={actionInProgress}
                        class="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition-colors disabled:opacity-50 flex items-center gap-1.5">
                        <Papicon icon="check" size={14} /> {m.e7_alr_approve_btn()}
                      </button>
                      <button onclick={() => decide(request, 'REJECTED')} disabled={actionInProgress}
                        class="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold transition-colors disabled:opacity-50 flex items-center gap-1.5">
                        <Papicon icon="x" size={14} /> {m.e7_alr_reject_btn()}
                      </button>
                    </div>
                    <p class="text-[11px] text-on-surface-variant/50">
                      {m.e7_alr_permission_note()}
                    </p>
                  </div>
                {:else}
                  <div class="rounded-lg bg-surface border border-outline-variant/15 p-3 text-sm">
                    <p class="font-semibold text-on-surface">
                      {m.e7_alr_decision_label({ status: STATUS_META[request.status]?.label ?? '' })}
                      {#if request.decidedByTag}<span class="text-on-surface-variant/60 font-normal"> {m.e7_alr_decision_by({ tag: request.decidedByTag })}</span>{/if}
                      {#if request.decidedAt}<span class="text-on-surface-variant/60 font-normal"> {m.e7_alr_decision_on({ date: formatDate(request.decidedAt) })}</span>{/if}
                    </p>
                    {#if request.decisionReason}
                      <p class="text-on-surface-variant/80 mt-1">{request.decisionReason}</p>
                    {/if}
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</ModulePage>
