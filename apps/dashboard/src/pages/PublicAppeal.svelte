<script lang="ts">
  import { onMount } from 'svelte';
  import { API_BASE_URL } from '../lib/api';
  import { authStore } from '../lib/stores/auth.svelte';
  import { loadGoogleFont, themeBaseCss, themeStyleVars, type FormTheme } from '../lib/formTheme';
  import Papicon from '../lib/components/Papicon.svelte';
  import { m, dateLocale } from '../lib/i18n';

  const { guildId }: { guildId: string } = $props();

  // ── Types ──────────────────────────────────────────────────────────────────
  interface AppealField {
    id: string; type: string; label: string; description?: string;
    required: boolean; placeholder?: string; options?: string[];
  }
  interface AppealForm {
    id: string;
    structure: { title?: string; description?: string; headerColor?: string; fields: AppealField[] };
    theme: FormTheme | null;
    customCss: string | null;
  }
  interface AppealableSanction {
    id: string;
    type: string;
    typeLabel: string;
    reason: string;
    status: string;
    durationSeconds: number | null;
    expiresAt: string | null;
    createdAt: string;
    moderatorTag: string | null;
  }
  interface AppealData {
    guildId: string;
    guildName: string;
    guildIcon: string | null;
    welcomeText: string | null;
    cooldownDays: number;
    appealableTypes?: string[];
    maxSanctionsPerAppeal?: number;
    form: AppealForm | null;
    /** Formulaire dédié par type de sanction, quand le serveur en configure un. */
    formsByType?: Record<string, AppealForm | null>;
    viewer: {
      userId: string;
      username?: string;
      eligibility:
        | { eligible: true; banReason: string | null; banned: boolean; sanctions: AppealableSanction[]; maxSelectable: number }
        | { eligible: false; blockedBy: 'not_banned' | 'blacklisted' | 'active_appeal' | 'cooldown' | 'nothing_to_appeal'; cooldownEndsAt?: string };
      latestAppeal: {
        id: string; status: string; createdAt: string; decidedAt: string | null;
        decisionReason: string | null; infoRequest: string | null; infoResponse: string | null;
        messages?: any[] | null;
      } | null;
    } | null;
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let data = $state<AppealData | null>(null);
  let loading = $state(true);
  let notFound = $state(false);
  let submitting = $state(false);
  let submitted = $state(false);
  let submitError = $state('');
  let answers = $state<Record<string, string | string[]>>({});
  let errors = $state<Record<string, string>>({});
  let infoResponseText = $state('');
  let infoResponseSent = $state(false);
  /** Sanctions cochées par le membre, et son argumentaire pour chacune. */
  let selectedSanctionIds = $state<string[]>([]);
  let statements = $state<Record<string, string>>({});

  // ── Derived ────────────────────────────────────────────────────────────────
  const viewer = $derived(data?.viewer || null);
  const blockedEligibility = $derived(
    viewer?.eligibility.eligible === false ? viewer.eligibility : null
  );
  const eligible = $derived(viewer?.eligibility.eligible === true ? viewer.eligibility : null);
  const appealableSanctions = $derived(eligible?.sanctions ?? []);
  const maxSelectable = $derived(eligible?.maxSelectable ?? 3);
  // Un membre non banni doit désigner ce qu'il conteste : sans ban actif, un
  // appel qui ne vise aucune sanction ne porte sur rien.
  const selectionRequired = $derived(!!eligible && !eligible.banned);

  /** Ordre d'affichage des types, aligné sur le service côté bot. */
  const TYPE_ORDER = ['WARN', 'TIMEOUT', 'KICK', 'SOFTBAN', 'TEMP_BAN', 'BAN'];

  // Contester un warn ne pose pas les mêmes questions qu'un ban : si le serveur
  // a défini un formulaire pour un des types cochés, c'est lui qui s'affiche.
  const activeForm = $derived.by(() => {
    const byType = data?.formsByType ?? {};
    const selectedTypes = new Set(
      selectedSanctionIds
        .map((id) => appealableSanctions.find((entry) => entry.id === id)?.type)
        .filter((type): type is string => !!type)
    );
    for (const type of TYPE_ORDER) {
      if (selectedTypes.has(type) && byType[type]) return byType[type];
    }
    return data?.form ?? null;
  });

  const theme = $derived(activeForm?.theme || null);
  const accent = $derived(theme?.accentColor || activeForm?.structure?.headerColor || '#6366f1');
  const fields = $derived((activeForm?.structure?.fields || []).filter(f => f.type !== 'section_header' && f.type !== 'discord_connect'));
  const injectedCss = $derived(
    [themeBaseCss(theme), (activeForm?.customCss || '').replace(/<\/style/gi, '')].filter(Boolean).join('\n')
  );
  const rootStyle = $derived([
    themeStyleVars(theme, accent),
    theme?.backgroundColor ? `background:${theme.backgroundColor}` : '',
    theme?.fontFamily ? 'font-family:var(--form-font)' : '',
  ].filter(Boolean).join(';'));

  $effect(() => { if (theme?.fontFamily) loadGoogleFont(theme.fontFamily); });

  // ── Load ───────────────────────────────────────────────────────────────────
  async function load() {
    loading = true;
    try {
      const headers: Record<string, string> = {};
      if (authStore.token) headers.Authorization = `Bearer ${authStore.token}`;
      const res = await fetch(`${API_BASE_URL}/api/public/appeal/${guildId}`, { headers });
      if (!res.ok) { notFound = true; return; }
      data = await res.json() as AppealData;
    } catch {
      notFound = true;
    } finally {
      loading = false;
    }
  }

  onMount(async () => {
    await load();
    // Le DM de sanction pointe ici avec ?sanction=<id> : on coche la bonne ligne
    // pour que le membre n'ait pas à la retrouver.
    const requested = new URLSearchParams(window.location.search).get('sanction');
    if (requested && appealableSanctions.some((entry) => entry.id === requested)) {
      selectedSanctionIds = [requested];
    }
  });

  function toggleSanction(id: string) {
    if (selectedSanctionIds.includes(id)) {
      selectedSanctionIds = selectedSanctionIds.filter((entry) => entry !== id);
      return;
    }
    if (selectedSanctionIds.length >= maxSelectable) {
      submitError = m.pa_max_sanctions({ count: maxSelectable });
      return;
    }
    submitError = '';
    selectedSanctionIds = [...selectedSanctionIds, id];
  }

  function loginWithDiscord() {
    window.location.href = `${API_BASE_URL}/api/auth/discord/login?returnTo=${encodeURIComponent(window.location.pathname)}`;
  }

  // ── Submit appeal ──────────────────────────────────────────────────────────
  function validate(): boolean {
    if (selectionRequired && selectedSanctionIds.length === 0) {
      submitError = m.pa_select_sanction();
      return false;
    }
    const newErrors: Record<string, string> = {};
    for (const field of fields) {
      const val = answers[field.id];
      if (field.required && (!val || (Array.isArray(val) && val.length === 0) || val === '')) {
        newErrors[field.id] = m.pa_field_required();
      }
    }
    errors = newErrors;
    return Object.keys(newErrors).length === 0;
  }

  async function submit() {
    if (!validate()) return;
    submitting = true;
    submitError = '';
    try {
      const res = await fetch(`${API_BASE_URL}/api/public/appeal/${guildId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authStore.token}` },
        body: JSON.stringify({
          data: answers,
          sanctionIds: selectedSanctionIds,
          statements: Object.fromEntries(selectedSanctionIds.map((id) => [id, statements[id] ?? ''])),
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        submitError = err.error || m.pa_submit_error();
        return;
      }
      submitted = true;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch {
      submitError = m.pa_server_unreachable();
    } finally {
      submitting = false;
    }
  }

  async function sendInfoResponse() {
    if (!infoResponseText.trim()) return;
    submitting = true;
    submitError = '';
    try {
      const res = await fetch(`${API_BASE_URL}/api/public/appeal/${guildId}/info-response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authStore.token}` },
        body: JSON.stringify({ response: infoResponseText.trim() }),
      });
      if (!res.ok) {
        const err = await res.json();
        submitError = err.error || m.pa_send_error();
        return;
      }
      infoResponseSent = true;
      infoResponseText = '';
      await load();
    } catch {
      submitError = m.pa_server_unreachable();
    } finally {
      submitting = false;
    }
  }

  function setAnswer(id: string, value: string) { answers = { ...answers, [id]: value }; }
  function toggleCheckbox(id: string, option: string) {
    const current = (answers[id] as string[]) || [];
    answers = { ...answers, [id]: current.includes(option) ? current.filter(v => v !== option) : [...current, option] };
  }


  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function formatDateTime(iso: string): string {
    return new Date(iso).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
</script>

<svelte:head>
  <title>{m.pa_head_title({ server: data?.guildName ?? 'Kotbo' })}</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<div class="pf-root min-h-screen bg-gradient-to-br from-surface to-surface-container-low/50 py-8 px-4" style={rootStyle}>

  {#if injectedCss}
    {@html `<style>${injectedCss}</style>`}
  {/if}

  {#if loading}
    <div class="flex items-center justify-center min-h-[60vh]">
      <div class="text-center">
        <div class="w-12 h-12 rounded-full border-4 border-primary/20 border-t-primary animate-spin mx-auto mb-4"></div>
        <p class="text-on-surface-variant/60">{m.pa_loading()}</p>
      </div>
    </div>

  {:else if notFound}
    <div class="max-w-lg mx-auto text-center py-24 flex flex-col items-center justify-center">
      <div class="mb-6 text-on-surface-variant/30">
        <Papicon icon="lock" size={56} />
      </div>
      <h1 class="text-2xl font-semibold text-on-surface mb-3">{m.pa_unavailable()}</h1>
      <p class="text-on-surface-variant/60 text-sm">{m.pa_unavailable_desc()}</p>
    </div>

  {:else if data}
    <div class="max-w-2xl mx-auto space-y-4">

      <!-- Bannière du thème -->
      {#if theme?.bannerUrl}
        <div class="pf-banner rounded-xl overflow-hidden shadow-lg border border-outline-variant/20">
          <img src={theme.bannerUrl} alt="" class="w-full max-h-52 object-cover" />
        </div>
      {/if}

      <!-- En-tête serveur -->
      <div class="pf-card rounded-xl overflow-hidden shadow-lg border border-outline-variant/20">
        <div class="h-3" style="background:var(--form-color)"></div>
        <div class="bg-surface p-6 flex items-center gap-4">
          {#if theme?.logoUrl || data.guildIcon}
            <img src={theme?.logoUrl || data.guildIcon} alt="" class="pf-logo w-16 h-16 rounded-2xl object-cover shadow-md shrink-0" />
          {/if}
          <div class="min-w-0">
            <h1 class="text-2xl font-semibold text-on-surface truncate">{data.guildName}</h1>
            <p class="text-on-surface-variant/70 text-sm mt-1">{m.pa_title()}</p>
            {#if data.welcomeText || theme?.welcomeText}
              <p class="mt-2 text-sm leading-relaxed" style="color:var(--form-color)">{data.welcomeText || theme?.welcomeText}</p>
            {/if}
          </div>
        </div>
      </div>

      {#if !authStore.isAuthenticated}
        <!-- Connexion Discord obligatoire -->
        <div class="pf-card rounded-xl bg-surface border border-outline-variant/20 p-8 text-center shadow-sm flex flex-col items-center">
          <div class="mb-4 text-on-surface-variant/30">
            <Papicon icon="lock" size={48} />
          </div>
          <h2 class="text-lg font-semibold text-on-surface mb-2">{m.pa_login_required()}</h2>
          <p class="text-sm text-on-surface-variant/70 mb-6 leading-relaxed">
            {m.pa_login_desc()}
          </p>
          <button onclick={loginWithDiscord}
            class="pf-submit px-6 py-3 rounded-xl text-white font-semibold text-sm shadow-lg transition-all "
            style="background:#5865F2">
            {m.pa_login_button()}
          </button>
        </div>

      {:else if submitted}
        <!-- Confirmation de soumission -->
        <div class="pf-card rounded-xl bg-surface border border-outline-variant/20 p-10 text-center shadow-sm">
          <div class="w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6"
            style="background:color-mix(in srgb, var(--form-color) 15%, transparent)">
            <svg class="w-10 h-10" viewBox="0 0 24 24" fill="none">
              <path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--form-color)" />
            </svg>
          </div>
          <h2 class="text-2xl font-semibold text-on-surface mb-3">{m.pa_sent_title()}</h2>
          <p class="text-on-surface-variant/70 text-sm leading-relaxed">
            {theme?.confirmationText || m.pa_sent_desc()}
          </p>
        </div>

      {:else if viewer?.latestAppeal && viewer.latestAppeal.status === 'NEEDS_INFO' && !infoResponseSent}
        <!-- Le staff demande des infos complémentaires -->
        <div class="pf-card rounded-xl bg-surface border border-blue-500/30 p-6 shadow-sm space-y-4">
          <div class="flex items-center gap-3">
            <span class="text-blue-500 flex items-center justify-center shrink-0">
              <Papicon icon="message-square" size={32} />
            </span>
            <div>
              <h2 class="font-semibold text-on-surface">{m.pa_needs_info_title()}</h2>
              <p class="text-xs text-on-surface-variant/60 mt-0.5">{m.pa_needs_info_desc()}</p>
            </div>
          </div>

          {#if viewer.latestAppeal.messages && viewer.latestAppeal.messages.length > 0}
            <div class="space-y-3 max-h-80 overflow-y-auto pr-1">
              {#each viewer.latestAppeal.messages as msg}
                <div class="flex flex-col p-3 rounded-lg text-sm border {msg.author === 'staff' ? 'bg-blue-500/5 border-blue-500/20' : 'bg-surface border-outline-variant/15'}">
                  <div class="flex items-center justify-between text-xs font-semibold text-on-surface-variant/60 mb-1">
                    <span>{msg.author === 'staff' ? m.pa_staff() : m.pa_you()}</span>
                    <span>{formatDateTime(msg.createdAt)}</span>
                  </div>
                  <p class="whitespace-pre-wrap">{msg.content}</p>
                </div>
              {/each}
            </div>
          {:else if viewer.latestAppeal.infoRequest}
            <div class="rounded-lg bg-blue-500/5 border border-blue-500/20 p-4 text-sm text-on-surface/90 leading-relaxed">
              {viewer.latestAppeal.infoRequest}
            </div>
          {/if}

          <textarea bind:value={infoResponseText} rows="5" maxlength="2000"
            placeholder={m.pa_response_placeholder()}
            class="w-full bg-surface-container rounded-xl px-4 py-3 text-sm outline-none border-b-2 border-primary/20 focus:border-primary transition-colors resize-y"></textarea>
          {#if submitError}
            <p class="pf-error text-xs text-rose-500">{submitError}</p>
          {/if}
          <div class="flex justify-end">
            <button onclick={sendInfoResponse} disabled={submitting || !infoResponseText.trim()}
              class="pf-submit px-6 py-2.5 rounded-xl text-white font-semibold text-sm shadow disabled:opacity-50"
              style="background:var(--form-color)">
              {submitting ? m.pa_sending() : m.pa_send_response()}
            </button>
          </div>
        </div>

      {:else if infoResponseSent || (viewer?.latestAppeal && (viewer.latestAppeal.status === 'PENDING'))}
        <!-- Demande en cours -->
        {@const appeal = viewer?.latestAppeal}
        <div class="space-y-4">
          <div class="pf-card rounded-xl bg-surface border border-outline-variant/20 p-8 text-center shadow-sm flex flex-col items-center">
            <div class="mb-4 text-on-surface-variant/30">
              <Papicon icon="clock" size={48} />
            </div>
            <h2 class="text-lg font-semibold text-on-surface mb-2">{m.pa_pending_title()}</h2>
            <p class="text-sm text-on-surface-variant/70 leading-relaxed mb-0">
              {#if infoResponseSent}
                {m.pa_response_forwarded()}
              {/if}
              {appeal ? m.pa_pending_desc_dated({ date: formatDate(appeal.createdAt) }) : m.pa_pending_desc()}
              {m.pa_pending_dm()}
            </p>
          </div>

          {#if appeal && ((appeal.messages && appeal.messages.length > 0) || appeal.infoRequest)}
            <div class="pf-card rounded-xl bg-surface border border-outline-variant/20 p-6 shadow-sm space-y-4">
              <h3 class="font-semibold text-on-surface text-sm flex items-center gap-2">
                <Papicon icon="message-square" size={18} />
                {m.pa_discussion_history()}
              </h3>
              <div class="space-y-3 max-h-80 overflow-y-auto pr-1">
                {#if appeal.messages && appeal.messages.length > 0}
                  {#each appeal.messages as msg}
                    <div class="flex flex-col p-3 rounded-lg text-sm border {msg.author === 'staff' ? 'bg-blue-500/5 border-blue-500/20' : 'bg-surface border-outline-variant/15'}">
                      <div class="flex items-center justify-between text-xs font-semibold text-on-surface-variant/60 mb-1">
                        <span>{msg.author === 'staff' ? m.pa_staff() : m.pa_you()}</span>
                        <span>{formatDateTime(msg.createdAt)}</span>
                      </div>
                      <p class="whitespace-pre-wrap">{msg.content}</p>
                    </div>
                  {/each}
                {:else if appeal.infoRequest}
                  <div class="flex flex-col p-3 rounded-lg text-sm border bg-blue-500/5 border-blue-500/20">
                    <div class="flex items-center justify-between text-xs font-semibold text-on-surface-variant/60 mb-1">
                      <span>{m.pa_staff()}</span>
                    </div>
                    <p class="whitespace-pre-wrap">{appeal.infoRequest}</p>
                  </div>
                  {#if appeal.infoResponse}
                    <div class="flex flex-col p-3 rounded-lg text-sm border bg-surface border-outline-variant/15">
                      <div class="flex items-center justify-between text-xs font-semibold text-on-surface-variant/60 mb-1">
                        <span>{m.pa_you()}</span>
                      </div>
                      <p class="whitespace-pre-wrap">{appeal.infoResponse}</p>
                    </div>
                  {/if}
                {/if}
              </div>
            </div>
          {/if}
        </div>

      {:else if viewer && blockedEligibility}
        <!-- Non éligible -->
        {@const blocked = blockedEligibility}
        {@const lastAppeal = viewer.latestAppeal}
        <div class="pf-card rounded-xl bg-surface border border-outline-variant/20 p-8 shadow-sm space-y-4">
          {#if blocked.blockedBy === 'not_banned'}
            <div class="text-center flex flex-col items-center justify-center">
              <div class="mb-4 text-on-surface-variant/30">
                <Papicon icon="check" size={48} />
              </div>
              <h2 class="text-lg font-semibold text-on-surface mb-2">{m.pa_not_banned()}</h2>
              <p class="text-sm text-on-surface-variant/70">
                Le compte <span class="font-semibold">{viewer.username || viewer.userId}</span> {m.pa_not_banned_desc()}
                {#if lastAppeal && lastAppeal.status === 'ACCEPTED'}
                  {m.pa_accepted_on({ date: lastAppeal.decidedAt ? formatDate(lastAppeal.decidedAt) : '' })}
                {/if}
              </p>
            </div>
          {:else if blocked.blockedBy === 'blacklisted'}
            <div class="text-center flex flex-col items-center justify-center">
              <div class="mb-4 text-on-surface-variant/30">
                <Papicon icon="block" size={48} />
              </div>
              <h2 class="text-lg font-semibold text-on-surface mb-2">{m.pa_not_allowed()}</h2>
              <p class="text-sm text-on-surface-variant/70">
                {m.pa_not_allowed_desc()}
              </p>
              {#if lastAppeal?.decisionReason}
                <p class="mt-3 text-xs text-on-surface-variant/50">{m.pa_reason({ reason: lastAppeal.decisionReason })}</p>
              {/if}
            </div>
          {:else if blocked.blockedBy === 'cooldown'}
            <div class="text-center flex flex-col items-center justify-center">
              <div class="mb-4 text-on-surface-variant/30">
                <Papicon icon="clock" size={48} />
              </div>
              <h2 class="text-lg font-semibold text-on-surface mb-2">{m.pa_denied_recently()}</h2>
              <p class="text-sm text-on-surface-variant/70 leading-relaxed">
                {lastAppeal?.decisionReason ? m.pa_denied_recently_desc_reason({ reason: lastAppeal.decisionReason }) : m.pa_denied_recently_desc()}
                {#if blocked.cooldownEndsAt}
                  {m.pa_cooldown_until()}
                  <span class="font-semibold" style="color:var(--form-color)">{formatDate(blocked.cooldownEndsAt)}</span>.
                {/if}
              </p>
            </div>
          {:else if blocked.blockedBy === 'nothing_to_appeal'}
            <div class="text-center flex flex-col items-center justify-center">
              <div class="mb-4 text-on-surface-variant/30">
                <Papicon icon="check" size={48} />
              </div>
              <h2 class="text-lg font-semibold text-on-surface mb-2">{m.pa_nothing_title()}</h2>
              <p class="text-sm text-on-surface-variant/70">{m.pa_nothing_desc()}</p>
            </div>
          {:else}
            <div class="text-center flex flex-col items-center justify-center">
              <div class="mb-4 text-on-surface-variant/30">
                <Papicon icon="clock" size={48} />
              </div>
              <h2 class="text-lg font-semibold text-on-surface mb-2">{m.pa_already_pending()}</h2>
              <p class="text-sm text-on-surface-variant/70">{m.pa_already_pending_desc()}</p>
            </div>
          {/if}
        </div>

      {:else if viewer && viewer.eligibility.eligible && activeForm}
        <!-- Formulaire d'appel -->
        <div class="pf-card rounded-xl bg-surface border border-outline-variant/20 p-5 shadow-sm flex items-center gap-3">
          <img
            src={authStore.user?.avatar ? `https://cdn.discordapp.com/avatars/${authStore.user.id}/${authStore.user.avatar}.png` : ''}
            alt="" class="w-10 h-10 rounded-full border border-outline-variant/30 {authStore.user?.avatar ? '' : 'hidden'}" />
          <div class="flex-1 min-w-0">
            <p class="text-sm font-semibold text-on-surface">{m.pa_logged_in_as({ name: viewer.username || authStore.user?.username })}</p>
            <p class="text-xs text-on-surface-variant/60 mt-0.5">
              {#if viewer.eligibility.banReason}
                {m.pa_ban_confirmed_reason({ reason: viewer.eligibility.banReason })}
              {:else if selectionRequired}
                {m.pa_sanctions_found({ count: appealableSanctions.length })}
              {:else}
                {m.pa_ban_confirmed()}
              {/if}
            </p>
          </div>
          <button onclick={() => authStore.logout()}
            class="px-3 py-1.5 border border-outline-variant/35 text-on-surface-variant rounded-lg text-xs font-semibold shrink-0">
            {m.pa_switch_account()}
          </button>
        </div>

        {#if appealableSanctions.length > 0}
          <div class="pf-card rounded-xl bg-surface border border-outline-variant/20 p-5 shadow-sm space-y-3">
            <div>
              <p class="font-semibold text-on-surface text-[15px]">
                {m.pa_pick_sanctions()}{#if selectionRequired}<span class="text-rose-500 ml-1">*</span>{/if}
              </p>
              <p class="text-xs text-on-surface-variant/60 mt-1">
                {m.pa_pick_sanctions_desc({ count: maxSelectable })}
              </p>
            </div>

            <div class="space-y-2">
              {#each appealableSanctions as sanction (sanction.id)}
                {@const checked = selectedSanctionIds.includes(sanction.id)}
                <div class="rounded-xl border p-3 transition-colors {checked ? 'border-primary/50 bg-primary/5' : 'border-outline-variant/20 bg-surface-container/40'}">
                  <label class="flex items-start gap-3 cursor-pointer">
                    <input type="checkbox" {checked} onchange={() => toggleSanction(sanction.id)}
                      class="accent-primary w-4 h-4 mt-1 shrink-0" />
                    <span class="min-w-0 flex-1">
                      <span class="block text-sm font-semibold text-on-surface">
                        {sanction.typeLabel}
                        <span class="font-normal text-xs text-on-surface-variant/60">
                          · {formatDate(sanction.createdAt)}{sanction.moderatorTag ? ` · ${sanction.moderatorTag}` : ''}
                        </span>
                      </span>
                      <span class="block text-xs text-on-surface-variant/80 mt-0.5 break-words">{sanction.reason}</span>
                    </span>
                  </label>

                  {#if checked}
                    <textarea rows="3" maxlength="1500"
                      value={statements[sanction.id] ?? ''}
                      oninput={(e) => { statements = { ...statements, [sanction.id]: (e.target as HTMLTextAreaElement).value }; }}
                      placeholder={m.pa_statement_placeholder()}
                      class="w-full mt-3 bg-surface rounded-xl px-3 py-2.5 text-sm outline-none border-b-2 border-primary/20 focus:border-primary transition-colors resize-y"></textarea>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}

        {#each fields as field (field.id)}
          {@const error = errors[field.id]}
          <div class="pf-card pf-field rounded-lg bg-surface border border-outline-variant/20 p-5 shadow-sm {error ? 'ring-2 ring-rose-500/40' : ''}">
            <label for={field.id} class="block font-semibold text-on-surface mb-1 text-[15px]">
              {field.label}{#if field.required}<span class="text-rose-500 ml-1">*</span>{/if}
            </label>
            {#if field.description}
              <p class="text-xs text-on-surface-variant/60 mb-3">{field.description}</p>
            {/if}

            {#if field.type === 'paragraph'}
              <textarea id={field.id} value={(answers[field.id] as string) || ''} rows={4}
                oninput={(e) => setAnswer(field.id, (e.target as HTMLTextAreaElement).value)}
                placeholder={field.placeholder || ''}
                class="w-full bg-surface-container rounded-xl px-4 py-3 text-sm outline-none border-b-2 border-primary/20 focus:border-primary transition-colors resize-y"></textarea>
            {:else if field.type === 'multiple_choice'}
              <div class="space-y-2">
                {#each field.options || [] as opt}
                  <label class="flex items-center gap-3 p-3 rounded-xl cursor-pointer hover:bg-surface-container/50 transition-colors">
                    <input type="radio" name={field.id} value={opt} checked={answers[field.id] === opt}
                      onchange={() => setAnswer(field.id, opt)} class="accent-primary w-4 h-4" />
                    <span class="text-sm text-on-surface">{opt}</span>
                  </label>
                {/each}
              </div>
            {:else if field.type === 'checkboxes'}
              <div class="space-y-2">
                {#each field.options || [] as opt}
                  <label class="flex items-center gap-3 p-3 rounded-xl cursor-pointer hover:bg-surface-container/50 transition-colors">
                    <input type="checkbox" checked={((answers[field.id] as string[]) || []).includes(opt)}
                      onchange={() => toggleCheckbox(field.id, opt)} class="accent-primary w-4 h-4 rounded" />
                    <span class="text-sm text-on-surface">{opt}</span>
                  </label>
                {/each}
              </div>
            {:else if field.type === 'dropdown'}
              <select id={field.id} value={(answers[field.id] as string) || ''}
                onchange={(e) => setAnswer(field.id, (e.target as HTMLSelectElement).value)}
                class="w-full bg-surface-container rounded-xl px-4 py-3 text-sm outline-none border border-outline-variant/30">
                <option value="" disabled>{m.pa_select()}</option>
                {#each field.options || [] as opt}<option value={opt}>{opt}</option>{/each}
              </select>
            {:else if field.type === 'date'}
              <input id={field.id} type="date" value={(answers[field.id] as string) || ''}
                onchange={(e) => setAnswer(field.id, (e.target as HTMLInputElement).value)}
                class="w-full bg-surface-container rounded-xl px-4 py-3 text-sm outline-none border border-outline-variant/30" />
            {:else}
              <input id={field.id} type={field.type === 'email' ? 'email' : field.type === 'number' ? 'number' : 'text'}
                value={(answers[field.id] as string) || ''}
                oninput={(e) => setAnswer(field.id, (e.target as HTMLInputElement).value)}
                placeholder={field.placeholder || ''}
                class="w-full bg-surface-container rounded-xl px-4 py-3 text-sm outline-none border-b-2 border-primary/20 focus:border-primary transition-colors" />
            {/if}

            {#if error}
              <p class="pf-error mt-2 text-xs text-rose-500">{error}</p>
            {/if}
          </div>
        {/each}

        {#if submitError}
          <div class="rounded-lg bg-rose-500/10 border border-rose-500/20 px-5 py-4 text-sm text-rose-600 font-medium">
            {submitError}
          </div>
        {/if}

        <div class="flex justify-end pb-8">
          <button onclick={submit} disabled={submitting}
            class="pf-submit px-8 py-3 rounded-xl text-white font-semibold text-sm shadow-lg transition-all active:scale-[0.98] disabled:opacity-60 disabled:scale-100"
            style="background:var(--form-color)">
            {submitting ? m.pa_sending() : m.pa_submit()}
          </button>
        </div>

      {:else}
        <!-- Config sans formulaire lié -->
        <div class="pf-card rounded-xl bg-surface border border-outline-variant/20 p-8 text-center shadow-sm flex flex-col items-center">
          <div class="mb-4 text-on-surface-variant/30">
            <Papicon icon="settings" size={48} />
          </div>
          <p class="text-sm text-on-surface-variant/70">{m.pa_no_form()}</p>
        </div>
      {/if}

      <div class="text-center pb-4 text-xs text-on-surface-variant/30">
        {m.pa_powered_by()} <span class="font-bold" style="color:var(--form-color)">Kotbo</span>
      </div>
    </div>
  {/if}
</div>
