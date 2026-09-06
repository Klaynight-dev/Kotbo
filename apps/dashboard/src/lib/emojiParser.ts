// ─────────────────────────────────────────────────────────────
// Kotbo Discord Emoji & Markdown Parser
// ─────────────────────────────────────────────────────────────

export function escapeHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Une URL n'est reprise dans un `href` que si son schema est inoffensif.
 * Sans ce filtre, `[clic](javascript:...)` produisait un lien executable, et
 * les blancs intercalaires (`java\nscript:`) suffisaient a contourner un test
 * naif sur le prefixe.
 */
const SAFE_URL_SCHEME = /^(?:https?:\/\/|mailto:|\/(?!\/))/i;

export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  // eslint-disable-next-line no-control-regex -- Retrait intentionnel des caractères de contrôle ASCII
  const candidate = url.replace(/[\u0000-\u0020\u007f]/g, '');
  return SAFE_URL_SCHEME.test(candidate) ? candidate : null;
}

export function parseDiscordEmojisAndMarkdown(text: string | null | undefined): string {
  if (!text) return '';

  // 1. Extract code blocks first to protect them from further parsing
  const codeBlocks: string[] = [];
  const raw = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlocks.length;
    const escapedCode = escapeHtml(code.replace(/\n$/, ''));
    codeBlocks.push(
      `<div class="my-1.5 rounded bg-[#1e1f22] border border-white/5 overflow-hidden">` +
      (lang ? `<div class="px-3 py-1 text-[10px] font-mono text-[#72767d] border-b border-white/5 uppercase tracking-wider">${escapeHtml(lang)}</div>` : '') +
      `<pre class="px-3 py-2 font-mono text-xs text-[#e3e5e8] whitespace-pre-wrap leading-relaxed overflow-x-auto">${escapedCode}</pre></div>`
    );
    return `\x00CODEBLOCK_${idx}\x00`;
  });

  // 2. Escape HTML for safety
  let html = escapeHtml(raw);

  // 3. Custom emojis
  html = html.replace(/&lt;a?:(\w+):(\d+)&gt;/g, (match, name, id) => {
    const isAnimated = match.startsWith('&lt;a:');
    const ext = isAnimated ? 'gif' : 'webp';
    return `<img src="https://cdn.discordapp.com/emojis/${id}.${ext}?size=48&quality=lossless" alt=":${name}:" title=":${name}:" class="inline-block h-[1.25em] w-[1.25em] mx-0.5 align-middle" style="vertical-align: -0.2em;" />`;
  });

  // 4. Spoiler tags: ||text||
  html = html.replace(/\|\|(.*?)\|\|/g, '<span class="bg-[#1e1f22] text-[#1e1f22] hover:text-[#dcddde] rounded px-1 py-0.5 cursor-pointer transition-colors duration-200" title="Spoiler">$1</span>');

  // 5. Headings (Discord supports # ## ### at line start)
  html = html.replace(/^### (.+)$/gm, '<h3 class="text-base font-bold text-white mt-2 mb-1 leading-snug">$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2 class="text-lg font-bold text-white mt-2 mb-1 leading-snug">$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1 class="text-xl font-bold text-white mt-2 mb-1 leading-snug">$1</h1>');

  // 6. Blockquotes: > text or >>> multiline
  html = html.replace(/^&gt;&gt;&gt; ([\s\S]+)$/gm, '<div class="border-l-4 border-[#4e5058] pl-3 my-1">$1</div>');
  html = html.replace(/^&gt; (.+)$/gm, '<div class="border-l-4 border-[#4e5058] pl-3 my-0.5">$1</div>');

  // 7. Unordered lists: - item or * item
  html = html.replace(/^(?:- |\* )(.+)$/gm, '<div class="flex gap-2 items-start ml-1"><span class="text-[#b5bac1] mt-px select-none">•</span><span>$1</span></div>');

  // 8. Discord markdown formatting (order matters: bold-italic first)
  html = html
    .replace(/\*\*\*(.*?)\*\*\*/g, '<strong class="font-bold text-white"><em class="italic">$1</em></strong>')
    .replace(/\*\*(.*?)\*\*/g, '<strong class="font-bold text-white">$1</strong>')
    .replace(/__(.*?)__/g, '<u class="underline">$1</u>')
    .replace(/~~(.*?)~~/g, '<del class="line-through opacity-70">$1</del>')
    .replace(/\*(.*?)\*/g, '<em class="italic">$1</em>')
    .replace(/_([^\s].*?[^\s])_/g, '<em class="italic">$1</em>')
    .replace(/`(.*?)`/g, '<code class="bg-[#1e1f22] px-1.5 py-0.5 rounded font-mono text-xs text-[#e3e5e8] border border-white/5">$1</code>');

  // 9. Masked links: [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) => {
    const href = safeUrl(url);
    if (!href) return label;
    return `<a href="${href}" class="text-[#00a8fc] hover:underline" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  // 10. Line breaks
  html = html.replace(/\n/g, '<br />');

  // 11. Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    html = html.replace(`\x00CODEBLOCK_${i}\x00`, codeBlocks[i]);
  }

  return html;
}
