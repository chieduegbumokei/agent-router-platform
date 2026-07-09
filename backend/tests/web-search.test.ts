import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/core/config';
import { webSearchTool } from '../src/tools/web-search';

const ctx = {
  userId: 'u1',
  conversationId: 'c1',
  history: [],
  signal: new AbortController().signal,
};

afterEach(() => {
  vi.unstubAllGlobals();
  config.tavilyApiKey = undefined;
});

describe('web search tool', () => {
  it('degrades gracefully with no API key (ok:false, model can still answer)', async () => {
    config.tavilyApiKey = undefined;
    const res = await webSearchTool.execute({ query: 'latest fed rate' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.content).toContain('search unavailable');
  });

  it('formats results inside untrusted-data delimiters', async () => {
    config.tavilyApiKey = 'test-key';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          results: [
            { title: 'Fed holds rates', url: 'https://example.com/fed', content: 'The Fed held rates steady at its June meeting.' },
          ],
        }),
      })),
    );

    const res = await webSearchTool.execute({ query: 'fed rate' }, ctx);
    expect(res.ok).toBe(true);
    expect(res.content).toContain('<search_results>');
    expect(res.content).toContain('Fed holds rates');
    expect(res.content).toContain('Untrusted web content');
  });

  it('maps HTTP failures to ok:false without throwing', async () => {
    config.tavilyApiKey = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429 })));
    const res = await webSearchTool.execute({ query: 'q' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.content).toContain('429');
  });

  it('maps network errors to ok:false without throwing', async () => {
    config.tavilyApiKey = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))));
    const res = await webSearchTool.execute({ query: 'q' }, ctx);
    expect(res.ok).toBe(false);
  });
});
