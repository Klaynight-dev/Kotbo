<script lang="ts">
  import Papicon from '../Papicon.svelte';

  const {
    open = false,
    title = 'Éditer le message',
    initialText = '',
    onSave,
    onClose,
  }: {
    open?: boolean;
    title?: string;
    initialText?: string;
    onSave?: (text: string) => void;
    onClose?: () => void;
  } = $props();

  let text = $state('');

  // La modale reste montee entre deux ouvertures : sans resynchronisation a
  // l'ouverture, elle rouvrait sur la saisie abandonnee la fois d'avant des lors
  // que le champ edite n'avait pas change entre-temps.
  $effect(() => {
    if (open) text = initialText;
  });

  function insertVariable(variable: string) {
    text = text ? `${text} ${variable}` : variable;
  }

  function handleSave() {
    onSave?.(text);
    onClose?.();
  }

  // Formatage simple pour l'aperçu Discord
  const renderedDiscordText = $derived(() => {
    if (!text.trim()) return 'Exemple de message...';
    const output = text
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\{membre\}/gi, '<span class="px-1.5 py-0.5 rounded bg-indigo-500/30 text-indigo-300 font-medium">@Membre</span>')
      .replace(/\{author\}/gi, '<span class="px-1.5 py-0.5 rounded bg-indigo-500/30 text-indigo-300 font-medium">@Auteur</span>')
      .replace(/\{channel\}/gi, '<span class="px-1.5 py-0.5 rounded bg-indigo-500/30 text-indigo-300 font-medium">#salon</span>')
      .replace(/\{salon\}/gi, '<span class="px-1.5 py-0.5 rounded bg-indigo-500/30 text-indigo-300 font-medium">#salon</span>')
      .replace(/\{serveur\}/gi, '<span class="font-semibold text-slate-200">Mon Serveur</span>');
    return output;
  });
</script>

{#if open}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200">
    <div class="w-full max-w-2xl rounded-2xl bg-surface-container-high border border-outline-variant/20 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
      <!-- Header -->
      <div class="px-5 py-4 border-b border-outline-variant/15 flex items-center justify-between bg-surface-container-highest/40">
        <div class="flex items-center gap-2">
          <div class="p-2 rounded-xl bg-primary/10 text-primary">
            <Papicon icon="TextBubble" size={18} />
          </div>
          <div>
            <h3 class="text-sm font-bold text-on-surface">{title}</h3>
            <p class="text-[11px] text-on-surface-variant/70">Éditeur avec aperçu Discord en temps réel</p>
          </div>
        </div>
        <button
          onclick={onClose}
          class="p-1.5 rounded-lg text-on-surface-variant/70 hover:text-on-surface hover:bg-surface-container-highest transition-colors"
        >
          <Papicon icon="Cross" size={16} />
        </button>
      </div>

      <!-- Body -->
      <div class="p-5 space-y-4 overflow-y-auto">
        <!-- Boutons d'insertion rapide de variables -->
        <div class="space-y-1.5">
          <p id="msg-modal-variables" class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70">
            Insérer une variable dynamique
          </p>
          <div class="flex flex-wrap gap-2" role="group" aria-labelledby="msg-modal-variables">
            <button
              type="button"
              onclick={() => insertVariable('{membre}')}
              class="px-2.5 py-1 rounded-lg text-xs font-medium bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border border-indigo-500/30 hover:bg-indigo-500/25 transition-all flex items-center gap-1"
            >
              <span>@Membre</span>
              <span class="text-[10px] opacity-60">{"{membre}"}</span>
            </button>
            <button
              type="button"
              onclick={() => insertVariable('{salon}')}
              class="px-2.5 py-1 rounded-lg text-xs font-medium bg-sky-500/15 text-sky-700 dark:text-sky-300 border border-sky-500/30 hover:bg-sky-500/25 transition-all flex items-center gap-1"
            >
              <span>#Salon</span>
              <span class="text-[10px] opacity-60">{"{salon}"}</span>
            </button>
            <button
              type="button"
              onclick={() => insertVariable('{serveur}')}
              class="px-2.5 py-1 rounded-lg text-xs font-medium bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25 transition-all flex items-center gap-1"
            >
              <span>Nom du serveur</span>
              <span class="text-[10px] opacity-60">{"{serveur}"}</span>
            </button>
          </div>
        </div>

        <!-- Zone de texte -->
        <div class="space-y-1.5">
          <label for="msg-modal-input" class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70">
            Contenu du message
          </label>
          <textarea
            id="msg-modal-input"
            bind:value={text}
            rows="5"
            placeholder="Saisissez le texte de votre message ici..."
            class="w-full px-3.5 py-2.5 rounded-xl bg-surface-container-highest border border-outline-variant/30 text-sm text-on-surface focus:border-primary/50 focus:outline-none transition-all resize-y"
          ></textarea>
        </div>

        <!-- Aperçu Discord WYSIWYG -->
        <div class="space-y-1.5">
          <p class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70 flex items-center gap-1.5">
            <Papicon icon="Camera" size={12} />
            <span>Aperçu Discord (WYSIWYG)</span>
          </p>
          <div class="p-4 rounded-xl bg-[#313338] border border-[#2b2d31] text-[#dbdee1] font-sans shadow-inner">
            <div class="flex items-start gap-3">
              <!-- Avatar Bot -->
              <div class="w-10 h-10 rounded-full bg-[#5865f2] flex items-center justify-center text-white font-bold text-sm shrink-0 shadow">
                K
              </div>
              <div class="space-y-1 min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="font-semibold text-white text-sm">Kotbo</span>
                  <span class="px-1 py-0.2 rounded bg-[#5865f2] text-[9px] font-bold text-white uppercase tracking-wider">BOT</span>
                  <span class="text-[11px] text-[#949ba4]">Aujourd'hui à 12:00</span>
                </div>
                <div class="text-sm leading-relaxed whitespace-pre-wrap break-words">
                  {@html renderedDiscordText()}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div class="px-5 py-3 border-t border-outline-variant/15 bg-surface-container-highest/30 flex items-center justify-end gap-2">
        <button
          type="button"
          onclick={onClose}
          class="px-4 py-2 rounded-xl text-xs font-semibold bg-surface-container-highest text-on-surface-variant hover:text-on-surface transition-all"
        >
          Annuler
        </button>
        <button
          type="button"
          onclick={handleSave}
          class="px-5 py-2 rounded-xl text-xs font-semibold bg-primary text-on-primary hover:opacity-90 transition-all flex items-center gap-1.5"
        >
          <Papicon icon="Check" size={14} />
          <span>Valider et appliquer</span>
        </button>
      </div>
    </div>
  </div>
{/if}
