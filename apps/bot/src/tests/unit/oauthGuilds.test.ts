import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { fetchOAuthGuilds, clearOAuthGuildsCache, type DiscordOAuthGuild } from '../../api/routes/user.js';

describe('fetchOAuthGuilds', () => {
  const originalFetch = globalThis.fetch;
  let fetchCallCount = 0;
  let fetchMockImpl: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;

  beforeEach(() => {
    clearOAuthGuildsCache();
    fetchCallCount = 0;
    fetchMockImpl = null;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      fetchCallCount++;
      const url = typeof input === 'string' ? input : input.toString();
      if (fetchMockImpl) {
        return fetchMockImpl(url, init);
      }
      const sampleGuilds: DiscordOAuthGuild[] = [
        { id: '111', name: 'Guilde 1', icon: null, owner: true, permissions: '8' },
        { id: '222', name: 'Guilde 2', icon: null, owner: false, permissions: '32' },
      ];
      return new Response(JSON.stringify(sampleGuilds), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearOAuthGuildsCache();
  });

  test('coalesces concurrent requests for the same token (single-flight)', async () => {
    // Simule un délai de réponse de 50ms sur l'API Discord
    fetchMockImpl = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const sample: DiscordOAuthGuild[] = [
        { id: '111', name: 'Guilde 1', icon: null, owner: true, permissions: '8' },
      ];
      return new Response(JSON.stringify(sample), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const [res1, res2] = await Promise.all([
      fetchOAuthGuilds('mon-jeton-discord'),
      fetchOAuthGuilds('mon-jeton-discord'),
    ]);

    expect(fetchCallCount).toBe(1);
    expect(res1).toEqual(res2);
    expect(res1).toHaveLength(1);
    expect(res1[0].name).toBe('Guilde 1');
  });

  test('serves subsequent requests from cache within TTL', async () => {
    const res1 = await fetchOAuthGuilds('mon-jeton-discord');
    expect(fetchCallCount).toBe(1);
    expect(res1).toHaveLength(2);

    const res2 = await fetchOAuthGuilds('mon-jeton-discord');
    expect(fetchCallCount).toBe(1);
    expect(res2).toEqual(res1);
  });

  test('forceFresh = true bypasses cache', async () => {
    await fetchOAuthGuilds('mon-jeton-discord');
    expect(fetchCallCount).toBe(1);

    await fetchOAuthGuilds('mon-jeton-discord', true);
    expect(fetchCallCount).toBe(2);
  });

  test('retries on 429 rate limit and succeeds', async () => {
    let attempt = 0;
    fetchMockImpl = async () => {
      attempt++;
      if (attempt === 1) {
        return new Response(JSON.stringify({ message: 'Rate limited', retry_after: 0.05 }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0.05' },
        });
      }
      return new Response(
        JSON.stringify([{ id: '999', name: 'Serveur Récupéré', icon: null, owner: true, permissions: '8' }]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const guilds = await fetchOAuthGuilds('jeton-avec-429');
    expect(attempt).toBe(2);
    expect(guilds).toHaveLength(1);
    expect(guilds[0].id).toBe('999');
  });

  test('falls back to stale cache if Discord subsequently fails', async () => {
    // 1. Initial success
    await fetchOAuthGuilds('jeton-fallback');
    expect(fetchCallCount).toBe(1);

    // 2. Discord becomes unavailable on force refresh
    fetchMockImpl = async () => {
      return new Response(JSON.stringify({ error: 'Discord down' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const staleResult = await fetchOAuthGuilds('jeton-fallback', true);
    expect(staleResult).toHaveLength(2);
    expect(staleResult[0].id).toBe('111');
  });
});
