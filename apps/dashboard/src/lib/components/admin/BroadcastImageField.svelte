<script lang="ts">
  /**
   * Champ image d'un broadcast : upload hébergé, glisser-déposer, collage, ou
   * URL externe.
   *
   * Pourquoi un composant dédié plutôt qu'un simple `<input type="url">` :
   * l'ancienne version n'acceptait qu'une URL, et les liens que l'on obtient
   * naturellement (copie depuis Discord, `data:` d'un aperçu local) ne
   * s'affichent jamais dans un embed. Le champ refuse donc explicitement ces
   * deux formes, en expliquant quoi faire, et propose l'upload à la place.
   */
  import Papicon from '../Papicon.svelte';
  import AdminBadge from './AdminBadge.svelte';
  import { toast } from '../../stores/toast.svelte';
  import {
    uploadBroadcastMedia,
    BROADCAST_MEDIA_ACCEPTED,
    BROADCAST_MEDIA_MAX_BYTES,
  } from '../../api';

  let {
    value = $bindable(''),
    label,
    hint = '',
    aspect = 'wide',
  }: {
    value?: string;
    label: string;
    hint?: string;
    aspect?: 'wide' | 'square';
  } = $props();

  let uploading = $state(false);
  let dragOver = $state(false);
  let previewFailed = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);

  /**
   * Diagnostic local de l'URL saisie. Même règles que côté bot
   * (`checkEmbedImageUrl`) : mieux vaut le dire avant l'envoi qu'après.
   */
  const diagnosis = $derived.by(() => {
    const url = value.trim();
    if (!url) return null;

    if (url.startsWith('data:')) {
      return {
        level: 'error' as const,
        message: "Une image encodée en base64 n'est jamais chargée par Discord. Utilisez le bouton d'upload.",
      };
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { level: 'error' as const, message: 'URL invalide.' };
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { level: 'error' as const, message: `Protocole non supporté (${parsed.protocol}).` };
    }

    const isDiscordCdn = /(^|\.)cdn\.discordapp\.com$/.test(parsed.hostname)
      || /(^|\.)media\.discordapp\.net$/.test(parsed.hostname);
    if (isDiscordCdn && parsed.searchParams.has('ex') && parsed.searchParams.has('hm')) {
      return {
        level: 'error' as const,
        message: 'Lien Discord signé : il expire au bout de quelques heures et l’embed affichera « Échec du chargement de l’image ». Uploadez le fichier ici.',
      };
    }

    if (parsed.protocol === 'http:') {
      return { level: 'warning' as const, message: 'Lien non sécurisé (HTTP) : Discord peut refuser de le charger.' };
    }

    if (parsed.pathname.includes('/api/public/broadcast-media/')) {
      return { level: 'ok' as const, message: 'Image hébergée par Kotbo - lien permanent.' };
    }

    return { level: 'ok' as const, message: 'Lien externe : il doit rester accessible publiquement.' };
  });

  async function upload(file: File | null | undefined) {
    if (!file) return;
    uploading = true;
    try {
      const media = await uploadBroadcastMedia(file);
      value = media.url;
      previewFailed = false;
      toast.success(`${media.fileName} hébergée (${Math.round(media.size / 1024)} Ko)`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur lors de l'upload");
    } finally {
      uploading = false;
      if (fileInput) fileInput.value = '';
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragOver = false;
    void upload(event.dataTransfer?.files?.[0]);
  }

  // Coller une capture d'écran directement dans le champ est le geste le plus
  // courant pour une annonce ; sans ça l'utilisateur colle une `data:` URL.
  function onPaste(event: ClipboardEvent) {
    const file = Array.from(event.clipboardData?.items ?? [])
      .find((item) => item.kind === 'file' && item.type.startsWith('image/'))
      ?.getAsFile();
    if (file) {
      event.preventDefault();
      void upload(file);
    }
  }

  $effect(() => {
    void value;
    previewFailed = false;
  });
</script>

<div class="space-y-2">
  <div class="flex items-center justify-between gap-2">
    <label for="img-{label}" class="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">
      {label}
    </label>
    {#if value.trim() && diagnosis}
      <AdminBadge
        size="sm"
        label={diagnosis.level === 'ok' ? 'Compatible' : diagnosis.level === 'warning' ? 'À vérifier' : 'Incompatible'}
        tone={diagnosis.level === 'ok' ? 'success' : diagnosis.level === 'warning' ? 'warning' : 'danger'}
      />
    {/if}
  </div>

  <div class="flex gap-2">
    <input
      id="img-{label}"
      bind:value
      onpaste={onPaste}
      type="url"
      placeholder="https://… ou déposez un fichier"
      class="flex-1 min-w-0 h-10 px-3 rounded-xl bg-surface-container-low/70 border text-sm text-on-surface
        placeholder:text-on-surface-variant focus:outline-none focus:ring-2 focus:ring-primary/15 transition
        {diagnosis?.level === 'error'
          ? 'border-red-500/50 focus:border-red-500'
          : 'border-outline-variant/25 focus:border-primary/60'}"
    />
    <button
      type="button"
      onclick={() => fileInput?.click()}
      disabled={uploading}
      class="shrink-0 h-10 px-3.5 rounded-xl bg-primary/12 text-primary border border-primary/25 text-[13px] font-semibold
        hover:bg-primary/18 transition disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
    >
      {#if uploading}
        <span class="w-3.5 h-3.5 rounded-full border-2 border-primary/30 border-t-primary animate-spin"></span>
        Envoi…
      {:else}
        <Papicon icon="Upload" size={14} />
        Uploader
      {/if}
    </button>
    {#if value.trim()}
      <button
        type="button"
        onclick={() => (value = '')}
        aria-label="Retirer l'image"
        class="shrink-0 w-10 h-10 rounded-xl bg-on-surface/6 text-on-surface-variant hover:bg-red-500/12 hover:text-red-500 transition flex items-center justify-center"
      >
        <Papicon icon="Trash" size={14} />
      </button>
    {/if}
  </div>

  <input
    bind:this={fileInput}
    type="file"
    accept={BROADCAST_MEDIA_ACCEPTED.join(',')}
    class="hidden"
    onchange={(event) => upload((event.currentTarget as HTMLInputElement).files?.[0])}
  />

  <!-- Zone de dépôt / aperçu -->
  <div
    role="button"
    tabindex="0"
    aria-label="Déposer une image"
    ondragover={(event) => { event.preventDefault(); dragOver = true; }}
    ondragleave={() => (dragOver = false)}
    ondrop={onDrop}
    onclick={() => { if (!value.trim()) fileInput?.click(); }}
    onkeydown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && !value.trim()) { event.preventDefault(); fileInput?.click(); } }}
    class="rounded-xl border-2 border-dashed transition-colors overflow-hidden
      {dragOver ? 'border-primary bg-primary/6' : 'border-outline-variant/30 bg-surface-container-low/30'}
      {value.trim() ? '' : 'cursor-pointer hover:border-primary/50'}"
  >
    {#if value.trim() && diagnosis?.level !== 'error' && !previewFailed}
      <img
        src={value}
        alt="Aperçu"
        onerror={() => (previewFailed = true)}
        class="w-full {aspect === 'square' ? 'max-h-32 object-contain' : 'max-h-44 object-cover'}"
      />
    {:else}
      <div class="flex flex-col items-center justify-center gap-1.5 py-6 px-4 text-center">
        <Papicon
          icon={previewFailed || diagnosis?.level === 'error' ? 'AlertTriangle' : 'Image'}
          size={20}
          class={previewFailed || diagnosis?.level === 'error' ? 'text-red-500' : 'text-on-surface-variant'}
        />
        {#if previewFailed}
          <p class="text-[13px] font-semibold text-red-500">Image non chargeable</p>
          <p class="text-[12px] text-on-surface-variant max-w-xs">
            Ce lien ne renvoie pas d’image accessible. Discord affichera « Échec du chargement de l’image ».
          </p>
        {:else if diagnosis?.level === 'error'}
          <p class="text-[13px] font-semibold text-red-500">Lien incompatible</p>
        {:else}
          <p class="text-[13px] font-semibold text-on-surface">Déposez une image ou cliquez</p>
          <p class="text-[12px] text-on-surface-variant">
            PNG, JPEG, GIF, WEBP - {Math.round(BROADCAST_MEDIA_MAX_BYTES / 1024 / 1024)} Mo max
          </p>
        {/if}
      </div>
    {/if}
  </div>

  {#if diagnosis}
    <p
      class="text-[12px] leading-snug flex items-start gap-1.5
        {diagnosis.level === 'ok' ? 'text-on-surface-variant' : diagnosis.level === 'warning' ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}"
    >
      <Papicon
        icon={diagnosis.level === 'ok' ? 'CheckCircle' : 'AlertTriangle'}
        size={12}
        class="mt-0.5 shrink-0"
      />
      {diagnosis.message}
    </p>
  {:else if hint}
    <p class="text-[12px] text-on-surface-variant leading-snug">{hint}</p>
  {/if}
</div>
