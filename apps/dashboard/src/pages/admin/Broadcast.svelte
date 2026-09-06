<script lang="ts">
  /**
   * Console d'annonces globales.
   *
   * Réécrite autour de trois manques de la version précédente :
   *   1. aucune façon d'attacher une image - seule une URL était acceptée, et
   *      les liens dont on dispose naturellement (CDN Discord signé, `data:`)
   *      n'apparaissent jamais dans un embed ;
   *   2. aucun retour par serveur - deux compteurs agrégés, sans dire quels
   *      serveurs avaient échoué ni pourquoi ;
   *   3. aucun moyen de préparer une annonce (modèle) ni de la programmer.
   */
  import { onMount } from 'svelte';
  import { toast } from '../../lib/stores/toast.svelte';
  import { confirmDialog } from '../../lib/stores/confirmDialog.svelte';
  import {
    sendBroadcast,
    fetchBroadcastHistory,
    deleteBroadcastLog,
    fetchBroadcastEmojis,
    fetchBroadcastChannels,
    setBroadcastChannel,
    fetchBroadcastMedia,
    deleteBroadcastMedia,
    fetchBroadcastTemplates,
    createBroadcastTemplate,
    deleteBroadcastTemplate,
    fetchBroadcastDeliveries,
    cancelScheduledBroadcast,
    type BroadcastPayload,
    type BroadcastLogEntry,
    type BroadcastEmoji,
    type BroadcastGuildConfig,
    type BroadcastMedia,
    type BroadcastTemplate,
    type BroadcastDelivery,
    type BroadcastResult,
  } from '../../lib/api';
  import Papicon from '../../lib/components/Papicon.svelte';
  import Modal from '../../lib/components/Modal.svelte';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import AdminCard from '../../lib/components/admin/AdminCard.svelte';
  import AdminBadge from '../../lib/components/admin/AdminBadge.svelte';
  import AdminTable from '../../lib/components/admin/AdminTable.svelte';
  import AdminToolbar from '../../lib/components/admin/AdminToolbar.svelte';
  import AdminDrawer from '../../lib/components/admin/AdminDrawer.svelte';
  import BroadcastImageField from '../../lib/components/admin/BroadcastImageField.svelte';
  import DiscordEmbedPreview from '../../lib/components/admin/DiscordEmbedPreview.svelte';
  import type { AdminTableColumn, AdminTone } from '../../lib/components/admin/types';

  type Tab = 'compose' | 'media' | 'templates' | 'channels' | 'history';

  // ── Composition ───────────────────────────────────────────────────────────
  let title = $state('📢 Annonce Globale Kotbo');
  let message = $state('');
  let color = $state('#5865F2');
  let thumbnailUrl = $state('');
  let imageUrl = $state('');
  let footerText = $state("Système d'annonce globale Kotbo");
  let target = $state<'ALL' | 'ACTIVATED' | 'CUSTOM'>('ALL');
  let channelPref = $state<'AUTO' | 'NEWS' | 'PUBLIC' | 'STAFF' | 'FALLBACK'>('AUTO');
  let selectedGuilds = $state<string[]>([]);
  let scheduleEnabled = $state(false);
  let scheduledAt = $state('');

  // ── État de page ──────────────────────────────────────────────────────────
  let activeTab = $state<Tab>('compose');
  let loading = $state(true);
  let sending = $state(false);
  let showConfirm = $state(false);
  let showEmojiPicker = $state(false);
  let pickerTarget = $state<'title' | 'message'>('message');
  let lastResult = $state<BroadcastResult | null>(null);

  let history = $state<BroadcastLogEntry[]>([]);
  let emojis = $state<BroadcastEmoji[]>([]);
  let guilds = $state<BroadcastGuildConfig[]>([]);
  let mediaLibrary = $state<{ media: BroadcastMedia[]; usedBytes: number; quotaBytes: number }>({
    media: [], usedBytes: 0, quotaBytes: 0,
  });
  let templates = $state<BroadcastTemplate[]>([]);

  let guildSearch = $state('');
  let channelSearch = $state('');
  let channelFilter = $state('TODO');
  let savingChannel = $state<string | null>(null);
  let historySort = $state('createdAt');
  let historyDir = $state<'asc' | 'desc'>('desc');

  // Rapport de diffusion
  let deliveryDrawerOpen = $state(false);
  let deliveryLog = $state<BroadcastLogEntry | null>(null);
  let deliveries = $state<BroadcastDelivery[]>([]);
  let deliveryFilter = $state<'ALL' | 'SENT' | 'FAILED' | 'SKIPPED'>('ALL');
  let deliveriesLoading = $state(false);

  // Modèles
  let showTemplateModal = $state(false);
  let templateName = $state('');

  // ── Dérivés ───────────────────────────────────────────────────────────────
  const filteredGuilds = $derived(
    guilds.filter((g) =>
      g.name.toLowerCase().includes(guildSearch.toLowerCase()) || g.id.includes(guildSearch),
    ),
  );

  const targetedGuilds = $derived(
    target === 'ALL' ? guilds
      : target === 'ACTIVATED' ? guilds.filter((g) => g.activated)
        : guilds.filter((g) => selectedGuilds.includes(g.id)),
  );

  const targetedUnconfigured = $derived(targetedGuilds.filter((g) => g.channelStatus !== 'OK'));
  const needsConfigCount = $derived(guilds.filter((g) => g.channelStatus !== 'OK').length);

  const channelConfigList = $derived(
    guilds
      .filter((g) => channelFilter === 'ALL' || g.channelStatus !== 'OK')
      .filter((g) => g.name.toLowerCase().includes(channelSearch.toLowerCase()) || g.id.includes(channelSearch)),
  );

  const targetLabel = $derived(
    target === 'ALL' ? 'tous les serveurs'
      : target === 'ACTIVATED' ? 'les serveurs activés'
        : `${selectedGuilds.length} serveur(s) sélectionné(s)`,
  );

  /** Limites Discord : dépasser produit un rejet API, pas un message tronqué. */
  const titleOver = $derived(title.length > 256);
  const messageOver = $derived(message.length > 4000);
  const footerOver = $derived(footerText.length > 2048);

  const scheduleInvalid = $derived(
    scheduleEnabled && (!scheduledAt || new Date(scheduledAt).getTime() < Date.now() - 60_000),
  );

  const canSend = $derived(
    message.trim().length > 0
      && !titleOver && !messageOver && !footerOver
      && !scheduleInvalid
      && !(target === 'CUSTOM' && selectedGuilds.length === 0),
  );

  const sortedHistory = $derived.by(() => {
    const rows = [...history];
    const direction = historyDir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      switch (historySort) {
        case 'title': return a.title.localeCompare(b.title, 'fr') * direction;
        case 'successCount': return (a.successCount - b.successCount) * direction;
        case 'failCount': return (a.failCount - b.failCount) * direction;
        case 'status': return a.status.localeCompare(b.status) * direction;
        default: return (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) * direction;
      }
    });
    return rows;
  });

  const visibleDeliveries = $derived(
    deliveryFilter === 'ALL' ? deliveries : deliveries.filter((d) => d.status === deliveryFilter),
  );

  const scheduledCount = $derived(history.filter((log) => log.status === 'SCHEDULED').length);

  // ── Chargement ────────────────────────────────────────────────────────────
  onMount(() => { void reloadAll(); });

  async function reloadAll() {
    loading = true;
    try {
      const [hist, emojiData, channelData, media, tpl] = await Promise.all([
        fetchBroadcastHistory(50),
        fetchBroadcastEmojis(),
        fetchBroadcastChannels(),
        fetchBroadcastMedia().catch(() => ({ media: [], usedBytes: 0, quotaBytes: 0 })),
        fetchBroadcastTemplates().catch(() => ({ templates: [] })),
      ]);
      history = hist.logs;
      emojis = emojiData.emojis;
      guilds = channelData.guilds ?? [];
      mediaLibrary = media;
      templates = tpl.templates;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur de chargement');
    } finally {
      loading = false;
    }
  }

  // ── Rendu des emojis ──────────────────────────────────────────────────────
  function escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderEmojiPreview(text: string): string {
    if (!text) return '';
    let result = escapeHtml(text);
    for (const emoji of emojis) {
      const match = emoji.formatted.match(/<a?:(\w+):(\d+)>/);
      if (!match) continue;
      const [, discordName, emojiId] = match;
      const img = `<img src="https://cdn.discordapp.com/emojis/${emojiId}.webp?size=24" alt="${escapeHtml(emoji.key)}" class="inline-block w-[22px] h-[22px] align-text-bottom" />`;
      // Les formes complètes `<:nom:id>` d'abord : sinon la passe `:nom:` les casse.
      result = result.replace(new RegExp(`&lt;a?:${discordName}:\\d+&gt;`, 'g'), img);
      result = result.replaceAll(`:${discordName}:`, img);
      if (emoji.key !== discordName) result = result.replaceAll(`:${emoji.key}:`, img);
    }
    return result;
  }

  function renderTitlePreview(text: string): string {
    if (!text) return '';
    let result = escapeHtml(text);
    for (const emoji of emojis) {
      const match = emoji.formatted.match(/<a?:(\w+):(\d+)>/);
      if (!match) continue;
      const discordName = match[1];
      const unicode = emoji.unicode || '❓';
      result = result.replace(new RegExp(`&lt;a?:${discordName}:\\d+&gt;`, 'g'), unicode);
      result = result.replaceAll(`:${discordName}:`, unicode);
      if (emoji.key !== discordName) result = result.replaceAll(`:${emoji.key}:`, unicode);
    }
    return result;
  }

  function insertEmoji(emoji: BroadcastEmoji) {
    const name = emoji.formatted.match(/<a?:(\w+):\d+>/)?.[1] || emoji.discordName || emoji.key;
    if (pickerTarget === 'title') title += ` :${name}: `;
    else message += ` :${name}: `;
    showEmojiPicker = false;
  }

  // ── Envoi ─────────────────────────────────────────────────────────────────
  function buildPayload(dryRun: boolean): BroadcastPayload {
    return {
      title: title.trim() || undefined,
      message: message.trim(),
      color: color || undefined,
      thumbnailUrl: thumbnailUrl.trim() || undefined,
      imageUrl: imageUrl.trim() || undefined,
      footerText: footerText.trim() || undefined,
      target,
      targetGuilds: target === 'CUSTOM' ? selectedGuilds : undefined,
      channelPref,
      dryRun,
      scheduledAt: !dryRun && scheduleEnabled && scheduledAt ? new Date(scheduledAt).toISOString() : undefined,
    };
  }

  async function handleDryRun() {
    if (!canSend) { toast.error('Complétez le formulaire avant la simulation'); return; }
    try {
      const result = await sendBroadcast(buildPayload(true));
      lastResult = result;
      for (const warning of result.warnings ?? []) toast.warning(warning);
      toast.success(
        `Simulation : ${result.totalTargeted} serveur(s) ciblé(s)`
        + (result.unconfiguredCount ? `, dont ${result.unconfiguredCount} sans salon configuré` : ''),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur de simulation');
    }
  }

  async function confirmSend() {
    sending = true;
    try {
      const result = await sendBroadcast(buildPayload(false));
      lastResult = result;
      showConfirm = false;

      if (result.scheduled) {
        toast.success(`Annonce programmée pour le ${new Date(result.scheduledAt!).toLocaleString('fr-FR')}`);
      } else {
        toast.success(`Envoyé : ${result.successCount} succès, ${result.failCount} échec(s) sur ${result.totalTargeted}`);
        message = '';
      }

      history = (await fetchBroadcastHistory(50)).logs;
      activeTab = 'history';
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur d'envoi");
    } finally {
      sending = false;
    }
  }

  // ── Historique ────────────────────────────────────────────────────────────
  async function openDeliveries(log: BroadcastLogEntry) {
    deliveryLog = log;
    deliveryFilter = 'ALL';
    deliveryDrawerOpen = true;
    deliveriesLoading = true;
    try {
      deliveries = (await fetchBroadcastDeliveries(log.id)).deliveries;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur de chargement du rapport');
      deliveries = [];
    } finally {
      deliveriesLoading = false;
    }
  }

  async function handleCancel(log: BroadcastLogEntry) {
    if (!(await confirmDialog.danger(`Annuler l'annonce programmée « ${log.title} » ?`))) return;
    try {
      await cancelScheduledBroadcast(log.id);
      history = (await fetchBroadcastHistory(50)).logs;
      toast.success('Annonce annulée');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur d'annulation");
    }
  }

  async function handleDeleteLog(id: string) {
    if (!(await confirmDialog.danger('Supprimer cette entrée de l’historique ?'))) return;
    try {
      await deleteBroadcastLog(id);
      history = history.filter((log) => log.id !== id);
      toast.success('Entrée supprimée');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur de suppression');
    }
  }

  function reuse(log: BroadcastLogEntry | BroadcastTemplate) {
    title = log.title ?? '';
    message = log.message;
    color = log.color;
    thumbnailUrl = log.thumbnailUrl ?? '';
    imageUrl = log.imageUrl ?? '';
    footerText = log.footerText ?? '';
    target = (log.target as typeof target) ?? 'ALL';
    selectedGuilds = log.targetGuilds ?? [];
    channelPref = (log.channelPref as typeof channelPref) ?? 'AUTO';
    scheduleEnabled = false;
    activeTab = 'compose';
    toast.success('Contenu chargé dans l’éditeur');
  }

  // ── Modèles ───────────────────────────────────────────────────────────────
  async function saveTemplate() {
    if (!templateName.trim()) { toast.error('Nom du modèle requis'); return; }
    try {
      await createBroadcastTemplate({ ...buildPayload(false), name: templateName.trim() });
      templates = (await fetchBroadcastTemplates()).templates;
      showTemplateModal = false;
      templateName = '';
      toast.success('Modèle enregistré');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur d’enregistrement');
    }
  }

  async function removeTemplate(id: string) {
    if (!(await confirmDialog.danger('Supprimer ce modèle ?'))) return;
    try {
      await deleteBroadcastTemplate(id);
      templates = templates.filter((t) => t.id !== id);
      toast.success('Modèle supprimé');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur de suppression');
    }
  }

  // ── Médias ────────────────────────────────────────────────────────────────
  async function removeMedia(media: BroadcastMedia) {
    const used = media.usageCount > 0
      ? ` Elle a servi dans ${media.usageCount} annonce(s) : les embeds déjà publiés afficheront « Échec du chargement de l’image ».`
      : '';
    if (!(await confirmDialog.danger(`Supprimer ${media.fileName} ?${used}`))) return;
    try {
      await deleteBroadcastMedia(media.id);
      mediaLibrary = await fetchBroadcastMedia();
      toast.success('Image supprimée');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur de suppression');
    }
  }

  async function copyMediaUrl(media: BroadcastMedia) {
    try {
      await navigator.clipboard.writeText(media.url);
      toast.success('Lien copié');
    } catch {
      toast.error('Copie impossible');
    }
  }

  // ── Salons ────────────────────────────────────────────────────────────────
  async function saveChannelFor(guild: BroadcastGuildConfig, channelId: string | null) {
    savingChannel = guild.id;
    try {
      await setBroadcastChannel(guild.id, channelId);
      const channel = channelId ? guild.channels.find((c) => c.id === channelId) ?? null : null;
      guilds = guilds.map((g) => g.id === guild.id
        ? {
          ...g,
          broadcastChannelId: channelId,
          broadcastChannelName: channel?.name ?? null,
          channelStatus: channelId ? ('OK' as const) : ('UNSET' as const),
        }
        : g);
      toast.success(channelId ? `#${channel?.name} configuré pour ${guild.name}` : `Salon retiré pour ${guild.name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur de configuration');
    } finally {
      savingChannel = null;
    }
  }

  // ── Utilitaires d'affichage ───────────────────────────────────────────────
  const statusTone: Record<string, AdminTone> = {
    SENT: 'success', SENDING: 'info', SCHEDULED: 'warning',
    CANCELLED: 'neutral', FAILED: 'danger', DRAFT: 'neutral',
  };
  const statusLabel: Record<string, string> = {
    SENT: 'Envoyée', SENDING: 'En cours', SCHEDULED: 'Programmée',
    CANCELLED: 'Annulée', FAILED: 'Échec', DRAFT: 'Brouillon',
  };
  const deliveryTone: Record<string, AdminTone> = { SENT: 'success', FAILED: 'danger', SKIPPED: 'warning' };
  const deliveryLabel: Record<string, string> = { SENT: 'Envoyé', FAILED: 'Échec', SKIPPED: 'Ignoré' };

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
    return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
  }

  function formatDate(value: string): string {
    return new Date(value).toLocaleString('fr-FR', {
      day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  }

  const historyColumns: AdminTableColumn[] = [
    { key: 'title', label: 'Annonce', sortKey: 'title' },
    { key: 'status', label: 'Statut', sortKey: 'status', width: 'w-32' },
    { key: 'reach', label: 'Diffusion', sortKey: 'successCount', align: 'right', width: 'w-40' },
    { key: 'date', label: 'Date', sortKey: 'createdAt', align: 'right', width: 'w-40', hideBelow: 'md' },
    { key: 'actions', label: '', width: 'w-32', align: 'right' },
  ];

  const tabs: { id: Tab; label: string; icon: string; badge?: number }[] = $derived([
    { id: 'compose', label: 'Composer', icon: 'Pencil' },
    { id: 'media', label: 'Images', icon: 'Image', badge: mediaLibrary.media.length },
    { id: 'templates', label: 'Modèles', icon: 'Bookmark', badge: templates.length },
    { id: 'channels', label: 'Salons', icon: 'Hash', badge: needsConfigCount },
    { id: 'history', label: 'Historique', icon: 'Clock', badge: scheduledCount },
  ]);
</script>

<AdminShell
  title="Annonces globales"
  description="Composez, programmez et diffusez une annonce vers l’ensemble des serveurs Kotbo, avec un rapport de livraison serveur par serveur."
>
  {#snippet actions()}
    <button
      type="button"
      onclick={reloadAll}
      class="h-9 px-3.5 rounded-xl bg-on-surface/6 hover:bg-on-surface/10 border border-outline-variant/25 text-[13px] font-semibold text-on-surface-variant hover:text-on-surface transition inline-flex items-center gap-2"
    >
      <Papicon icon="RefreshCw" size={13} />
      Actualiser
    </button>
  {/snippet}

  <!-- Onglets -->
  <div class="flex items-center gap-1 p-1 rounded-xl bg-on-surface/5 border border-outline-variant/20 overflow-x-auto scrollbar-none">
    {#each tabs as tab (tab.id)}
      <button
        type="button"
        onclick={() => (activeTab = tab.id)}
        aria-current={activeTab === tab.id ? 'page' : undefined}
        class="shrink-0 inline-flex items-center gap-2 h-9 px-3.5 rounded-lg text-[13px] font-semibold transition-colors
          {activeTab === tab.id
            ? 'bg-surface-container-lowest text-on-surface shadow-sm'
            : 'text-on-surface-variant hover:text-on-surface'}"
      >
        <Papicon icon={tab.icon} size={14} />
        {tab.label}
        {#if tab.badge}
          <span class="px-1.5 py-0.5 rounded text-[10px] font-bold tabular-nums
            {tab.id === 'channels' && tab.badge > 0 ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400' : 'bg-on-surface/10 text-on-surface-variant'}">
            {tab.badge}
          </span>
        {/if}
      </button>
    {/each}
  </div>

  {#if activeTab === 'compose'}
    <div class="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,520px)] gap-5 items-start">
      <!-- Formulaire -->
      <div class="space-y-5">
        <AdminCard title="Contenu" icon="Pencil" tone="primary">
          <div class="space-y-4">
            <div>
              <div class="flex items-center justify-between mb-1.5">
                <label for="bc-title" class="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">Titre</label>
                <span class="text-[11px] tabular-nums {titleOver ? 'text-red-500 font-semibold' : 'text-on-surface-variant'}">{title.length}/256</span>
              </div>
              <div class="flex gap-2">
                <input
                  id="bc-title"
                  bind:value={title}
                  class="flex-1 h-10 px-3 rounded-xl bg-surface-container-low/70 border text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/15 transition
                    {titleOver ? 'border-red-500/50' : 'border-outline-variant/25 focus:border-primary/60'}"
                />
                <button
                  type="button"
                  onclick={() => { pickerTarget = 'title'; showEmojiPicker = !showEmojiPicker || pickerTarget !== 'title'; }}
                  aria-label="Insérer un emoji dans le titre"
                  class="shrink-0 w-10 h-10 rounded-xl bg-on-surface/6 hover:bg-on-surface/10 text-on-surface-variant hover:text-on-surface transition flex items-center justify-center"
                >
                  <Papicon icon="Smile" size={15} />
                </button>
              </div>
              <p class="text-[11.5px] text-on-surface-variant mt-1">
                Discord n’affiche pas d’emoji personnalisé dans un titre : ils sont remplacés par leur équivalent unicode.
              </p>
            </div>

            <div>
              <div class="flex items-center justify-between mb-1.5">
                <label for="bc-message" class="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">Message</label>
                <span class="text-[11px] tabular-nums {messageOver ? 'text-red-500 font-semibold' : 'text-on-surface-variant'}">{message.length}/4000</span>
              </div>
              <textarea
                id="bc-message"
                bind:value={message}
                rows="9"
                placeholder="Rédigez l’annonce. Markdown Discord et raccourcis :emoji: acceptés."
                class="w-full px-3 py-2.5 rounded-xl bg-surface-container-low/70 border text-sm text-on-surface leading-relaxed resize-y
                  placeholder:text-on-surface-variant focus:outline-none focus:ring-2 focus:ring-primary/15 transition
                  {messageOver ? 'border-red-500/50' : 'border-outline-variant/25 focus:border-primary/60'}"
              ></textarea>
              <button
                type="button"
                onclick={() => { pickerTarget = 'message'; showEmojiPicker = !showEmojiPicker || pickerTarget !== 'message'; }}
                class="mt-1.5 inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg bg-on-surface/5 hover:bg-on-surface/10 text-[12px] font-semibold text-on-surface-variant hover:text-on-surface transition"
              >
                <Papicon icon="Smile" size={13} />
                Emojis Kotbo
              </button>
            </div>

            {#if showEmojiPicker}
              <div class="rounded-xl border border-outline-variant/25 bg-surface-container-low/60 p-3">
                <p class="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant mb-2">
                  Insérer dans {pickerTarget === 'title' ? 'le titre' : 'le message'}
                </p>
                <div class="flex flex-wrap gap-1 max-h-40 overflow-y-auto">
                  {#each emojis as emoji (emoji.key)}
                    <button
                      type="button"
                      onclick={() => insertEmoji(emoji)}
                      title={emoji.key}
                      class="w-9 h-9 rounded-lg hover:bg-on-surface/10 transition flex items-center justify-center"
                    >
                      {#if emoji.formatted.match(/<a?:\w+:(\d+)>/)}
                        <img
                          src="https://cdn.discordapp.com/emojis/{emoji.formatted.match(/<a?:\w+:(\d+)>/)?.[1]}.webp?size=32"
                          alt={emoji.key}
                          class="w-5 h-5"
                        />
                      {:else}
                        <span class="text-base">{emoji.unicode}</span>
                      {/if}
                    </button>
                  {/each}
                </div>
              </div>
            {/if}

            <div>
              <div class="flex items-center justify-between mb-1.5">
                <label for="bc-footer" class="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">Pied de page</label>
                <span class="text-[11px] tabular-nums {footerOver ? 'text-red-500 font-semibold' : 'text-on-surface-variant'}">{footerText.length}/2048</span>
              </div>
              <input
                id="bc-footer"
                bind:value={footerText}
                class="w-full h-10 px-3 rounded-xl bg-surface-container-low/70 border text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/15 transition
                  {footerOver ? 'border-red-500/50' : 'border-outline-variant/25 focus:border-primary/60'}"
              />
            </div>

            <div>
              <label for="bc-color" class="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant mb-1.5 block">Couleur de la barre</label>
              <div class="flex items-center gap-2">
                <input id="bc-color" type="color" bind:value={color} class="w-10 h-10 rounded-xl border border-outline-variant/25 bg-transparent cursor-pointer" />
                <input
                  bind:value={color}
                  class="w-32 h-10 px-3 rounded-xl bg-surface-container-low/70 border border-outline-variant/25 text-sm font-mono text-on-surface focus:outline-none focus:border-primary/60"
                />
                <div class="flex gap-1.5">
                  {#each ['#5865F2', '#57F287', '#FEE75C', '#ED4245', '#EB459E'] as preset (preset)}
                    <button
                      type="button"
                      onclick={() => (color = preset)}
                      aria-label="Couleur {preset}"
                      class="w-7 h-7 rounded-lg border-2 transition {color.toUpperCase() === preset ? 'border-on-surface' : 'border-transparent'}"
                      style="background: {preset}"
                    ></button>
                  {/each}
                </div>
              </div>
            </div>
          </div>
        </AdminCard>

        <AdminCard
          title="Visuels"
          description="Uploadez le fichier pour obtenir un lien permanent hébergé par Kotbo."
          icon="Image"
          tone="info"
        >
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
            <BroadcastImageField bind:value={imageUrl} label="Image principale" />
            <BroadcastImageField bind:value={thumbnailUrl} label="Vignette" aspect="square" />
          </div>
        </AdminCard>

        <AdminCard title="Ciblage et diffusion" icon="Target" tone="warning">
          <div class="space-y-4">
            <div>
              <span class="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant mb-2 block">Destinataires</span>
              <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {#each [
                  { value: 'ALL' as const, label: 'Tous les serveurs', count: guilds.length, icon: 'Globe' },
                  { value: 'ACTIVATED' as const, label: 'Serveurs activés', count: guilds.filter((g) => g.activated).length, icon: 'CheckCircle' },
                  { value: 'CUSTOM' as const, label: 'Sélection manuelle', count: selectedGuilds.length, icon: 'ListChecks' },
                ] as option (option.value)}
                  <button
                    type="button"
                    onclick={() => (target = option.value)}
                    class="flex flex-col items-start gap-1 p-3 rounded-xl border text-left transition
                      {target === option.value
                        ? 'border-primary/45 bg-primary/8'
                        : 'border-outline-variant/25 bg-surface-container-low/40 hover:border-outline-variant/45'}"
                  >
                    <Papicon icon={option.icon} size={15} class={target === option.value ? 'text-primary' : 'text-on-surface-variant'} />
                    <span class="text-[13px] font-semibold text-on-surface">{option.label}</span>
                    <span class="text-[11px] text-on-surface-variant tabular-nums">{option.count} serveur(s)</span>
                  </button>
                {/each}
              </div>
            </div>

            {#if target === 'CUSTOM'}
              <div class="rounded-xl border border-outline-variant/25 bg-surface-container-low/40 p-3 space-y-2">
                <AdminToolbar bind:search={guildSearch} placeholder="Filtrer les serveurs…" />
                <div class="max-h-56 overflow-y-auto space-y-1">
                  {#each filteredGuilds as guild (guild.id)}
                    <label class="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-on-surface/5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedGuilds.includes(guild.id)}
                        onchange={(event) => {
                          selectedGuilds = (event.currentTarget as HTMLInputElement).checked
                            ? [...selectedGuilds, guild.id]
                            : selectedGuilds.filter((id) => id !== guild.id);
                        }}
                        class="w-4 h-4 rounded accent-(--primary-color)"
                      />
                      <span class="flex-1 min-w-0 text-[13px] text-on-surface truncate">{guild.name}</span>
                      {#if guild.channelStatus !== 'OK'}
                        <AdminBadge size="sm" label="Sans salon" tone="warning" />
                      {/if}
                    </label>
                  {/each}
                </div>
              </div>
            {/if}

            <div>
              <label for="bc-pref" class="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant mb-1.5 block">
                Salon de repli
              </label>
              <select
                id="bc-pref"
                bind:value={channelPref}
                class="w-full h-10 px-3 rounded-xl bg-surface-container-low/70 border border-outline-variant/25 text-sm text-on-surface focus:outline-none focus:border-primary/60"
              >
                <option value="AUTO">Automatique - annonces, puis public, puis staff</option>
                <option value="NEWS">Priorité salon d’annonces</option>
                <option value="PUBLIC">Priorité salon public</option>
                <option value="STAFF">Priorité salon staff</option>
                <option value="FALLBACK">Premier salon écrivable</option>
              </select>
              <p class="text-[11.5px] text-on-surface-variant mt-1">
                Le salon configuré dans l’onglet « Salons » prime toujours sur ce choix.
              </p>
            </div>

            <div class="rounded-xl border border-outline-variant/25 bg-surface-container-low/40 p-3 space-y-2">
              <label class="flex items-center gap-2.5 cursor-pointer">
                <input type="checkbox" bind:checked={scheduleEnabled} class="w-4 h-4 rounded accent-(--primary-color)" />
                <span class="text-[13px] font-semibold text-on-surface">Programmer l’envoi</span>
              </label>
              {#if scheduleEnabled}
                <input
                  type="datetime-local"
                  bind:value={scheduledAt}
                  class="w-full h-10 px-3 rounded-xl bg-surface-container-lowest border text-sm text-on-surface focus:outline-none focus:border-primary/60
                    {scheduleInvalid ? 'border-red-500/50' : 'border-outline-variant/25'}"
                />
                {#if scheduleInvalid}
                  <p class="text-[12px] text-red-500">Choisissez une date future.</p>
                {:else}
                  <p class="text-[11.5px] text-on-surface-variant">
                    L’annonce partira automatiquement, même si personne n’est connecté au dashboard.
                  </p>
                {/if}
              {/if}
            </div>
          </div>
        </AdminCard>
      </div>

      <!-- Aperçu et envoi (colonne collante) -->
      <div class="space-y-4 xl:sticky xl:top-24">
        <AdminCard title="Aperçu Discord" icon="Eye" padded={false}>
          <div class="p-4">
            <DiscordEmbedPreview
              {title}
              {message}
              {color}
              {imageUrl}
              {thumbnailUrl}
              {footerText}
              renderEmoji={renderEmojiPreview}
              renderTitle={renderTitlePreview}
            />
          </div>
        </AdminCard>

        <AdminCard title="Envoi" icon="Send" tone="danger">
          <div class="space-y-3">
            <div class="flex items-center justify-between text-[13px]">
              <span class="text-on-surface-variant">Cible</span>
              <span class="font-semibold text-on-surface">{targetedGuilds.length} serveur(s)</span>
            </div>

            {#if targetedUnconfigured.length > 0}
              <div class="rounded-xl border border-amber-500/25 bg-amber-500/8 p-3">
                <p class="text-[12.5px] text-amber-700 dark:text-amber-300 leading-snug">
                  <strong>{targetedUnconfigured.length} serveur(s)</strong> n’ont pas de salon de diffusion.
                  Kotbo tentera un repli automatique, sans garantie.
                </p>
                <button
                  type="button"
                  onclick={() => (activeTab = 'channels')}
                  class="mt-2 text-[12px] font-semibold text-amber-700 dark:text-amber-300 underline underline-offset-2"
                >
                  Configurer les salons
                </button>
              </div>
            {/if}

            {#if lastResult?.dryRun}
              <div class="rounded-xl border border-sky-500/25 bg-sky-500/8 p-3 text-[12.5px] text-sky-700 dark:text-sky-300">
                Simulation : {lastResult.totalTargeted} serveur(s) seraient contactés.
              </div>
            {/if}

            <div class="flex flex-col gap-2">
              <button
                type="button"
                onclick={handleDryRun}
                disabled={!canSend}
                class="h-10 rounded-xl bg-on-surface/6 hover:bg-on-surface/10 border border-outline-variant/25 text-[13px] font-semibold text-on-surface-variant hover:text-on-surface transition disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
              >
                <Papicon icon="Play" size={13} />
                Simuler
              </button>
              <button
                type="button"
                onclick={() => { showTemplateModal = true; }}
                disabled={!message.trim()}
                class="h-10 rounded-xl bg-on-surface/6 hover:bg-on-surface/10 border border-outline-variant/25 text-[13px] font-semibold text-on-surface-variant hover:text-on-surface transition disabled:opacity-40 inline-flex items-center justify-center gap-2"
              >
                <Papicon icon="Bookmark" size={13} />
                Enregistrer comme modèle
              </button>
              <button
                type="button"
                onclick={() => (showConfirm = true)}
                disabled={!canSend || sending}
                class="h-11 rounded-xl bg-primary text-white text-sm font-bold hover:bg-primary/90 transition disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
              >
                <Papicon icon={scheduleEnabled ? 'Clock' : 'Send'} size={15} />
                {scheduleEnabled ? 'Programmer' : 'Envoyer maintenant'}
              </button>
            </div>
          </div>
        </AdminCard>

        {#if lastResult && !lastResult.dryRun && (lastResult.failures?.length ?? 0) > 0}
          <AdminCard title="Échecs du dernier envoi" icon="AlertTriangle" tone="danger">
            <ul class="space-y-2 max-h-64 overflow-y-auto">
              {#each lastResult.failures ?? [] as failure (failure.guildId)}
                <li class="text-[12.5px]">
                  <div class="flex items-center gap-2">
                    <AdminBadge size="sm" label={deliveryLabel[failure.status]} tone={deliveryTone[failure.status]} />
                    <span class="font-semibold text-on-surface truncate">{failure.guildName}</span>
                  </div>
                  {#if failure.reason}
                    <p class="text-on-surface-variant mt-0.5 leading-snug">{failure.reason}</p>
                  {/if}
                </li>
              {/each}
            </ul>
          </AdminCard>
        {/if}
      </div>
    </div>

  {:else if activeTab === 'media'}
    <AdminCard
      title="Images hébergées"
      description="Ces images sont servies par Kotbo sur une URL permanente : c’est la seule forme qu’un embed Discord affiche durablement."
      icon="Image"
      tone="info"
    >
      {#snippet actions()}
        <span class="text-[12px] text-on-surface-variant tabular-nums">
          {formatBytes(mediaLibrary.usedBytes)} / {formatBytes(mediaLibrary.quotaBytes)}
        </span>
      {/snippet}

      {#if mediaLibrary.media.length === 0}
        <div class="py-12 flex flex-col items-center gap-2 text-center">
          <div class="w-11 h-11 rounded-2xl bg-on-surface/6 flex items-center justify-center text-on-surface-variant">
            <Papicon icon="Image" size={20} />
          </div>
          <p class="text-sm font-semibold text-on-surface">Aucune image hébergée</p>
          <p class="text-[13px] text-on-surface-variant max-w-sm">
            Déposez un fichier depuis l’onglet « Composer » : il apparaîtra ici et restera réutilisable.
          </p>
        </div>
      {:else}
        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {#each mediaLibrary.media as media (media.id)}
            <div class="rounded-xl border border-outline-variant/25 bg-surface-container-low/40 overflow-hidden group">
              <div class="aspect-video bg-surface-container flex items-center justify-center overflow-hidden">
                <img src={media.url} alt={media.fileName} class="w-full h-full object-cover" loading="lazy" />
              </div>
              <div class="p-2.5 space-y-1.5">
                <p class="text-[12.5px] font-semibold text-on-surface truncate" title={media.fileName}>{media.fileName}</p>
                <p class="text-[11px] text-on-surface-variant tabular-nums">
                  {formatBytes(media.size)} · {media.usageCount} usage(s)
                </p>
                <div class="flex gap-1.5">
                  <button
                    type="button"
                    onclick={() => { imageUrl = media.url; activeTab = 'compose'; toast.success('Image sélectionnée'); }}
                    class="flex-1 h-8 rounded-lg bg-primary/12 text-primary text-[12px] font-semibold hover:bg-primary/18 transition"
                  >
                    Utiliser
                  </button>
                  <button
                    type="button"
                    onclick={() => copyMediaUrl(media)}
                    aria-label="Copier le lien"
                    class="w-8 h-8 rounded-lg bg-on-surface/6 text-on-surface-variant hover:bg-on-surface/10 hover:text-on-surface transition flex items-center justify-center"
                  >
                    <Papicon icon="Copy" size={12} />
                  </button>
                  <button
                    type="button"
                    onclick={() => removeMedia(media)}
                    aria-label="Supprimer"
                    class="w-8 h-8 rounded-lg bg-on-surface/6 text-on-surface-variant hover:bg-red-500/12 hover:text-red-500 transition flex items-center justify-center"
                  >
                    <Papicon icon="Trash" size={12} />
                  </button>
                </div>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </AdminCard>

  {:else if activeTab === 'templates'}
    <AdminCard title="Modèles d’annonce" description="Réutilisez une mise en forme sans la ressaisir." icon="Bookmark" tone="primary">
      {#if templates.length === 0}
        <div class="py-12 flex flex-col items-center gap-2 text-center">
          <div class="w-11 h-11 rounded-2xl bg-on-surface/6 flex items-center justify-center text-on-surface-variant">
            <Papicon icon="Bookmark" size={20} />
          </div>
          <p class="text-sm font-semibold text-on-surface">Aucun modèle</p>
          <p class="text-[13px] text-on-surface-variant max-w-sm">
            Depuis l’onglet « Composer », enregistrez une annonce comme modèle pour la retrouver ici.
          </p>
        </div>
      {:else}
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          {#each templates as template (template.id)}
            <div class="rounded-xl border border-outline-variant/25 bg-surface-container-low/40 p-3.5 space-y-2">
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <p class="text-[14px] font-semibold text-on-surface truncate">{template.name}</p>
                  <p class="text-[12px] text-on-surface-variant truncate">{template.title || 'Sans titre'}</p>
                </div>
                <span class="w-3 h-8 rounded-full shrink-0" style="background: {template.color}"></span>
              </div>
              <p class="text-[12.5px] text-on-surface-variant line-clamp-3 leading-snug">{template.message}</p>
              <div class="flex gap-1.5 pt-1">
                <button
                  type="button"
                  onclick={() => reuse(template)}
                  class="flex-1 h-8 rounded-lg bg-primary/12 text-primary text-[12px] font-semibold hover:bg-primary/18 transition"
                >
                  Charger
                </button>
                <button
                  type="button"
                  onclick={() => removeTemplate(template.id)}
                  aria-label="Supprimer le modèle"
                  class="w-8 h-8 rounded-lg bg-on-surface/6 text-on-surface-variant hover:bg-red-500/12 hover:text-red-500 transition flex items-center justify-center"
                >
                  <Papicon icon="Trash" size={12} />
                </button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </AdminCard>

  {:else if activeTab === 'channels'}
    <div class="space-y-4">
      <AdminToolbar
        bind:search={channelSearch}
        bind:activeFilter={channelFilter}
        placeholder="Rechercher un serveur…"
        filters={[
          { value: 'TODO', label: 'À configurer', count: needsConfigCount },
          { value: 'ALL', label: 'Tous', count: guilds.length },
        ]}
        resultCount={channelConfigList.length}
        resultLabel="serveur"
      />

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {#each channelConfigList as guild (guild.id)}
          <div class="rounded-xl border border-outline-variant/25 bg-surface-container-lowest/70 p-3.5 flex items-center gap-3">
            <div class="w-9 h-9 shrink-0 rounded-xl bg-on-surface/6 overflow-hidden flex items-center justify-center">
              {#if guild.icon}
                <img src={guild.icon} alt="" class="w-full h-full object-cover" />
              {:else}
                <Papicon icon="Server" size={15} class="text-on-surface-variant" />
              {/if}
            </div>

            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <p class="text-[13.5px] font-semibold text-on-surface truncate">{guild.name}</p>
                <AdminBadge
                  size="sm"
                  label={guild.channelStatus === 'OK' ? 'Configuré' : guild.channelStatus === 'MISSING' ? 'Salon supprimé' : 'Non configuré'}
                  tone={guild.channelStatus === 'OK' ? 'success' : guild.channelStatus === 'MISSING' ? 'danger' : 'warning'}
                />
              </div>
              <select
                value={guild.broadcastChannelId ?? ''}
                disabled={savingChannel === guild.id}
                onchange={(event) => saveChannelFor(guild, (event.currentTarget as HTMLSelectElement).value || null)}
                class="mt-1.5 w-full h-8 px-2 rounded-lg bg-surface-container-low/70 border border-outline-variant/25 text-[12.5px] text-on-surface focus:outline-none focus:border-primary/60 disabled:opacity-50"
              >
                <option value="">- Aucun (repli automatique) -</option>
                {#each guild.channels as channel (channel.id)}
                  <option value={channel.id}>#{channel.name}{channel.category ? ` · ${channel.category}` : ''}</option>
                {/each}
              </select>
            </div>
          </div>
        {/each}
      </div>
    </div>

  {:else}
    <AdminTable
      columns={historyColumns}
      rows={sortedHistory}
      {loading}
      bind:sortKey={historySort}
      bind:sortDir={historyDir}
      emptyTitle="Aucune annonce"
      emptyHint="Les annonces envoyées et programmées apparaîtront ici avec leur rapport de diffusion."
      emptyIcon="Megaphone"
    >
      {#snippet row(item, _index)}
        {@const log = item as BroadcastLogEntry}
        <tr class="border-b border-outline-variant/12 hover:bg-on-surface/3 transition-colors">
          <td class="px-4 py-3">
            <div class="flex items-center gap-2.5 min-w-0">
              <span class="w-1 h-9 rounded-full shrink-0" style="background: {log.color}"></span>
              <div class="min-w-0">
                <p class="text-[13.5px] font-semibold text-on-surface truncate">{log.title}</p>
                <p class="text-[12px] text-on-surface-variant truncate max-w-md">{log.message}</p>
              </div>
              {#if log.imageUrl}
                <Papicon icon="Image" size={13} class="text-on-surface-variant shrink-0" />
              {/if}
            </div>
          </td>
          <td class="px-4 py-3">
            <AdminBadge label={statusLabel[log.status] ?? log.status} tone={statusTone[log.status] ?? 'neutral'} />
            {#if log.status === 'SCHEDULED' && log.scheduledAt}
              <p class="text-[11px] text-on-surface-variant mt-1 tabular-nums">{formatDate(log.scheduledAt)}</p>
            {/if}
          </td>
          <td class="px-4 py-3 text-right">
            <span class="text-[13px] font-semibold text-emerald-500 tabular-nums">{log.successCount}</span>
            <span class="text-on-surface-variant">/</span>
            <span class="text-[13px] tabular-nums {log.failCount > 0 ? 'text-red-500 font-semibold' : 'text-on-surface-variant'}">{log.failCount}</span>
            <p class="text-[11px] text-on-surface-variant tabular-nums">sur {log.totalTargeted}</p>
          </td>
          <td class="px-4 py-3 text-right hidden md:table-cell">
            <span class="text-[12.5px] text-on-surface-variant tabular-nums">{formatDate(log.createdAt)}</span>
            {#if log.username}
              <p class="text-[11px] text-on-surface-variant truncate">{log.username}</p>
            {/if}
          </td>
          <td class="px-4 py-3">
            <div class="flex items-center justify-end gap-1">
              {#if log.status === 'SCHEDULED'}
                <button
                  type="button"
                  onclick={() => handleCancel(log)}
                  aria-label="Annuler"
                  title="Annuler l’envoi programmé"
                  class="w-8 h-8 rounded-lg bg-on-surface/6 text-on-surface-variant hover:bg-amber-500/12 hover:text-amber-500 transition flex items-center justify-center"
                >
                  <Papicon icon="Ban" size={13} />
                </button>
              {:else}
                <button
                  type="button"
                  onclick={() => openDeliveries(log)}
                  aria-label="Rapport"
                  title="Rapport de diffusion"
                  class="w-8 h-8 rounded-lg bg-on-surface/6 text-on-surface-variant hover:bg-on-surface/12 hover:text-on-surface transition flex items-center justify-center"
                >
                  <Papicon icon="ListChecks" size={13} />
                </button>
              {/if}
              <button
                type="button"
                onclick={() => reuse(log)}
                aria-label="Réutiliser"
                title="Réutiliser dans l’éditeur"
                class="w-8 h-8 rounded-lg bg-on-surface/6 text-on-surface-variant hover:bg-primary/12 hover:text-primary transition flex items-center justify-center"
              >
                <Papicon icon="Copy" size={13} />
              </button>
              <button
                type="button"
                onclick={() => handleDeleteLog(log.id)}
                aria-label="Supprimer"
                class="w-8 h-8 rounded-lg bg-on-surface/6 text-on-surface-variant hover:bg-red-500/12 hover:text-red-500 transition flex items-center justify-center"
              >
                <Papicon icon="Trash" size={13} />
              </button>
            </div>
          </td>
        </tr>
      {/snippet}
    </AdminTable>
  {/if}
</AdminShell>

<!-- Rapport de diffusion serveur par serveur -->
<AdminDrawer
  bind:open={deliveryDrawerOpen}
  width="lg"
  title="Rapport de diffusion"
  subtitle={deliveryLog?.title ?? ''}
>
  <div class="space-y-4">
    <div class="flex flex-wrap gap-1.5">
      {#each [
        { value: 'ALL' as const, label: 'Tous', count: deliveries.length },
        { value: 'SENT' as const, label: 'Envoyés', count: deliveries.filter((d) => d.status === 'SENT').length },
        { value: 'FAILED' as const, label: 'Échecs', count: deliveries.filter((d) => d.status === 'FAILED').length },
        { value: 'SKIPPED' as const, label: 'Ignorés', count: deliveries.filter((d) => d.status === 'SKIPPED').length },
      ] as filter (filter.value)}
        <button
          type="button"
          onclick={() => (deliveryFilter = filter.value)}
          class="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12.5px] font-semibold transition
            {deliveryFilter === filter.value
              ? 'bg-primary/12 text-primary border border-primary/30'
              : 'bg-on-surface/5 text-on-surface-variant border border-transparent hover:bg-on-surface/8'}"
        >
          {filter.label}
          <span class="tabular-nums text-[11px]">{filter.count}</span>
        </button>
      {/each}
    </div>

    {#if deliveriesLoading}
      <div class="space-y-2">
        {#each Array(6) as _, index (index)}
          <div class="h-14 rounded-xl bg-on-surface/6 animate-pulse"></div>
        {/each}
      </div>
    {:else if visibleDeliveries.length === 0}
      <p class="text-[13px] text-on-surface-variant py-8 text-center">
        Aucune ligne pour ce filtre. Les rapports détaillés existent à partir des annonces envoyées après cette mise à jour.
      </p>
    {:else}
      <ul class="space-y-1.5">
        {#each visibleDeliveries as delivery (delivery.id)}
          <li class="rounded-xl border border-outline-variant/25 bg-surface-container-low/40 p-3">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="text-[13px] font-semibold text-on-surface truncate">{delivery.guildName}</p>
                <p class="text-[11.5px] text-on-surface-variant">
                  {delivery.channelName ? `#${delivery.channelName}` : 'Aucun salon'} · {delivery.guildId}
                </p>
              </div>
              <AdminBadge size="sm" label={deliveryLabel[delivery.status]} tone={deliveryTone[delivery.status]} />
            </div>
            {#if delivery.reason}
              <p class="text-[12px] text-on-surface-variant mt-1.5 leading-snug">{delivery.reason}</p>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</AdminDrawer>

<!-- Confirmation d'envoi -->
<Modal bind:open={showConfirm} title={scheduleEnabled ? 'Programmer l’annonce' : 'Confirmer l’envoi'} size="md">
  <div class="space-y-4">
    <p class="text-sm text-on-surface-variant leading-relaxed">
      {#if scheduleEnabled}
        L’annonce sera diffusée le <strong class="text-on-surface">{scheduledAt ? new Date(scheduledAt).toLocaleString('fr-FR') : ''}</strong>
        vers <strong class="text-on-surface">{targetedGuilds.length} serveur(s)</strong> ({targetLabel}).
      {:else}
        L’annonce va être publiée immédiatement sur <strong class="text-on-surface">{targetedGuilds.length} serveur(s)</strong> ({targetLabel}).
        Cette action est irréversible.
      {/if}
    </p>

    {#if imageUrl.trim() || thumbnailUrl.trim()}
      <div class="rounded-xl border border-outline-variant/25 bg-surface-container-low/40 p-3 text-[12.5px] text-on-surface-variant">
        Les visuels sont vérifiés avant diffusion : un lien que Discord ne saurait pas charger bloque l’envoi.
      </div>
    {/if}

    <div class="flex gap-2 justify-end">
      <button
        type="button"
        onclick={() => (showConfirm = false)}
        class="h-10 px-4 rounded-xl bg-on-surface/6 hover:bg-on-surface/10 text-[13px] font-semibold text-on-surface-variant transition"
      >
        Annuler
      </button>
      <button
        type="button"
        onclick={confirmSend}
        disabled={sending}
        class="h-10 px-5 rounded-xl bg-primary text-white text-[13px] font-bold hover:bg-primary/90 transition disabled:opacity-50 inline-flex items-center gap-2"
      >
        {#if sending}
          <span class="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin"></span>
          Envoi…
        {:else}
          {scheduleEnabled ? 'Programmer' : 'Envoyer'}
        {/if}
      </button>
    </div>
  </div>
</Modal>

<!-- Enregistrement d'un modèle -->
<Modal bind:open={showTemplateModal} title="Enregistrer comme modèle" size="sm">
  <div class="space-y-4">
    <div>
      <label for="tpl-name" class="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant mb-1.5 block">
        Nom du modèle
      </label>
      <input
        id="tpl-name"
        bind:value={templateName}
        placeholder="Maintenance planifiée"
        class="w-full h-10 px-3 rounded-xl bg-surface-container-low/70 border border-outline-variant/25 text-sm text-on-surface focus:outline-none focus:border-primary/60"
      />
    </div>
    <div class="flex gap-2 justify-end">
      <button
        type="button"
        onclick={() => (showTemplateModal = false)}
        class="h-10 px-4 rounded-xl bg-on-surface/6 hover:bg-on-surface/10 text-[13px] font-semibold text-on-surface-variant transition"
      >
        Annuler
      </button>
      <button
        type="button"
        onclick={saveTemplate}
        class="h-10 px-5 rounded-xl bg-primary text-white text-[13px] font-bold hover:bg-primary/90 transition"
      >
        Enregistrer
      </button>
    </div>
  </div>
</Modal>
