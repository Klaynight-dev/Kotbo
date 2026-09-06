import { describe, expect, test } from 'bun:test';
import { parseMarkdown } from '../../services/features/transcriptService';

describe('Transcript markdown & entity parser', () => {
  test('converts custom emojis properly', () => {
    // Static custom emoji
    const staticResult = parseMarkdown('Hello <:super_emoji:123456789012345678>!');
    expect(staticResult).toContain('<img class="discord-emoji" src="https://cdn.discordapp.com/emojis/123456789012345678.png" alt=":super_emoji:" title=":super_emoji:" />');

    // Animated custom emoji
    const animatedResult = parseMarkdown('Cool <a:gif_emoji:987654321098765432>!');
    expect(animatedResult).toContain('<img class="discord-emoji" src="https://cdn.discordapp.com/emojis/987654321098765432.gif" alt=":gif_emoji:" title=":gif_emoji:" />');
  });

  test('auto-links HTTP/HTTPS urls', () => {
    const simpleUrl = parseMarkdown('Check https://example.com/test');
    expect(simpleUrl).toBe('Check <a href="https://example.com/test" target="_blank" class="discord-link">https://example.com/test</a>');

    // URL inside <> (Discord syntax to hide embeds)
    const hiddenEmbedUrl = parseMarkdown('Check <https://example.com/path?a=1&b=2>');
    expect(hiddenEmbedUrl).toBe('Check &lt;<a href="https://example.com/path?a=1&amp;b=2" target="_blank" class="discord-link">https://example.com/path?a=1&amp;b=2</a>&gt;');

    // URL followed by punctuation
    const punctUrl = parseMarkdown('Go to https://example.com.');
    expect(punctUrl).toBe('Go to <a href="https://example.com" target="_blank" class="discord-link">https://example.com</a>.');
  });

  test('renders masked links instead of their raw syntax', () => {
    const angled = parseMarkdown('[Voir le message](<https://example.com/path?a=1&b=2>)');
    expect(angled).toBe('<a href="https://example.com/path?a=1&amp;b=2" target="_blank" class="discord-link">Voir le message</a>');

    const bold = parseMarkdown('**[Titre](https://example.com/x)**');
    expect(bold).toBe('<strong><a href="https://example.com/x" target="_blank" class="discord-link">Titre</a></strong>');

    // Les crochets echappes par le convertisseur Components V2 reviennent en clair.
    const bs = String.fromCharCode(92);
    const escapedLabel = parseMarkdown(`[Live ${bs}[FR${bs}] test](<https://example.com/live>)`);
    expect(escapedLabel).toContain('>Live [FR] test</a>');

    // Une URL non http reste du texte : pas de href fabrique.
    expect(parseMarkdown('[Titre](javascript:alert(1))')).toBe('[Titre](javascript:alert(1))');
  });

  test('leaves urls inside code blocks unlinked', () => {
    const inlineResult = parseMarkdown('Do not link `https://example.com` please');
    expect(inlineResult).toContain('<code class="inline-code">https://example.com</code>');
    expect(inlineResult).not.toContain('class="discord-link"');

    const blockResult = parseMarkdown('```js\nconst url = "https://example.com";\n```');
    expect(blockResult).toContain('<pre><code class="block-code language-js">const url = &quot;https://example.com&quot;;\n</code></pre>');
    expect(blockResult).not.toContain('class="discord-link"');
  });

  test('parses basic markdown successfully', () => {
    const boldItalic = parseMarkdown('**Bold** and *Italic* and __Underline__ and ~~Strike~~');
    expect(boldItalic).toContain('<strong>Bold</strong>');
    expect(boldItalic).toContain('<em>Italic</em>');
    expect(boldItalic).toContain('<u>Underline</u>');
    expect(boldItalic).toContain('<del>Strike</del>');
  });
});
