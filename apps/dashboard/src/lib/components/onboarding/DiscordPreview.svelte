<script lang="ts">
  /**
   * Ce que Discord affichera, montre pendant qu'on le regle.
   *
   * Le parcours faisait relire des gabarits : « Bienvenue {user} sur
   * **{server}** ! ». Personne ne juge une phrase a travers ses variables et ses
   * asterisques. Ici, la meme phrase est rendue la ou elle atterrira - salon,
   * avatar, pseudo, badge du bot -, et la question « est-ce que ca sonne bien ? »
   * redevient une question a laquelle on peut repondre.
   *
   * Les couleurs sont ecrites en dur, hors des jetons du tableau de bord : ce
   * cadre imite Discord, il ne suit pas le theme de Kotbo. En clair comme en
   * sombre, l'apercu doit ressembler a Discord et non a la page qui l'entoure.
   */
  import type { Snippet } from 'svelte';

  const {
    channel,
    author = 'Kotbo',
    avatarUrl = '/favicon.svg',
    bot = true,
    content,
    children,
  }: {
    channel: string;
    author?: string;
    avatarUrl?: string;
    bot?: boolean;
    /** Texte du message. Gras `**…**` et mentions `@…` sont rendus. */
    content?: string;
    children?: Snippet;
  } = $props();

  type Token = { kind: 'text' | 'bold' | 'mention'; value: string };

  /**
   * Un decoupage minimal, pas un moteur Markdown.
   *
   * Trois formes couvrent ce qu'un message d'accueil contient : du gras, une
   * mention, et le reste. Rendre davantage - listes, liens, blocs de code -
   * demanderait un analyseur, et l'apercu n'a pas a etre fidele au caractere
   * pres : il doit surtout ne pas afficher d'asterisques.
   */
  function tokenize(text: string): Token[] {
    const tokens: Token[] = [];
    // Le gras d'abord : une mention a l'interieur d'un `**…**` reste du gras,
    // ce qui est exactement ce que Discord fait.
    const pattern = /\*\*([^*]+)\*\*|(@[\w.-]+)/g;
    let cursor = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      if (match.index > cursor) tokens.push({ kind: 'text', value: text.slice(cursor, match.index) });
      if (match[1] !== undefined) tokens.push({ kind: 'bold', value: match[1] });
      else tokens.push({ kind: 'mention', value: match[2] });
      cursor = match.index + match[0].length;
    }

    if (cursor < text.length) tokens.push({ kind: 'text', value: text.slice(cursor) });
    return tokens;
  }

  const tokens = $derived(content ? tokenize(content) : []);

  const now = new Date();
  const stamp = `Aujourd'hui à ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
</script>

<div class="rounded-xl overflow-hidden border border-black/25 shadow-sm">
  <!-- Barre de salon -->
  <div class="flex items-center gap-2 px-3.5 py-2.5 bg-[#2b2d31] border-b border-black/25">
    <span class="text-[#80848e] text-[17px] leading-none font-medium">#</span>
    <span class="text-[13px] font-semibold text-[#dbdee1] truncate">{channel}</span>
  </div>

  <!-- Le message -->
  <div class="bg-[#313338] px-3.5 py-3.5">
    <div class="flex gap-3">
      <img src={avatarUrl} alt="" class="w-9 h-9 rounded-full shrink-0 bg-[#1e1f22]" />
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1.5 flex-wrap">
          <span class="text-[14px] font-medium text-[#f2f3f5]">{author}</span>
          {#if bot}
            <span class="text-[10px] font-semibold uppercase tracking-wide px-1 py-px rounded bg-[#5865f2] text-white">
              App
            </span>
          {/if}
          <span class="text-[11px] text-[#949ba4]">{stamp}</span>
        </div>

        {#if content}
          <p class="mt-0.5 text-[14px] leading-[1.4] text-[#dbdee1] whitespace-pre-wrap break-words">
            {#each tokens as token, index (index)}
              {#if token.kind === 'bold'}
                <strong class="font-bold">{token.value}</strong>
              {:else if token.kind === 'mention'}
                <span class="rounded px-0.5 bg-[#3c4270] text-[#c9cdfb] font-medium">{token.value}</span>
              {:else}
                {token.value}
              {/if}
            {/each}
          </p>
        {/if}

        {@render children?.()}
      </div>
    </div>
  </div>
</div>
