/**
 * Tests for the Theme Store registry client: TTL cache, force refresh,
 * stale-on-error fallback, and malformed-cache tolerance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRegistry, getCachedRegistry, revalidateRegistry } from '@/lib/themes/themeRegistry';

const CACHE_KEY = 'psysonic_theme_registry_cache';
const NOW = 1_000_000_000;
const TTL = 12 * 60 * 60 * 1000;

const reg = (generatedAt = 't') => ({ schemaVersion: 1, generatedAt, themes: [] });
const okRes = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const failRes = () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' });

function writeCache(ts: number, generatedAt: string): void {
  localStorage.setItem(CACHE_KEY, JSON.stringify({ ts, registry: reg(generatedAt) }));
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('fetchRegistry', () => {
  it('fetches and caches when there is no cache', async () => {
    const fetchMock = vi.fn(async () => okRes(reg('fresh')));
    vi.stubGlobal('fetch', fetchMock);

    const r = await fetchRegistry();
    expect(r.registry.generatedAt).toBe('fresh');
    expect(r.stale).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(CACHE_KEY)).toContain('fresh');
  });

  it('returns a fresh cache without fetching', async () => {
    writeCache(NOW, 'cached');
    const fetchMock = vi.fn(async () => okRes(reg('network')));
    vi.stubGlobal('fetch', fetchMock);

    const r = await fetchRegistry();
    expect(r.registry.generatedAt).toBe('cached');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('force-refreshes even with a fresh cache', async () => {
    writeCache(NOW, 'cached');
    const fetchMock = vi.fn(async () => okRes(reg('forced')));
    vi.stubGlobal('fetch', fetchMock);

    const r = await fetchRegistry({ force: true });
    expect(r.registry.generatedAt).toBe('forced');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to a stale cache when the fetch fails', async () => {
    writeCache(NOW - TTL - 1, 'stale'); // older than TTL → not fresh
    vi.stubGlobal('fetch', vi.fn(async () => failRes()));

    const r = await fetchRegistry();
    expect(r.registry.generatedAt).toBe('stale');
    expect(r.stale).toBe(true);
  });

  it('throws when the fetch fails and there is no cache', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => failRes()));
    await expect(fetchRegistry()).rejects.toThrow();
  });

  it('treats a malformed cache as no cache and fetches', async () => {
    localStorage.setItem(CACHE_KEY, '{ not valid json');
    expect(getCachedRegistry()).toBeNull();
    const fetchMock = vi.fn(async () => okRes(reg('fresh2')));
    vi.stubGlobal('fetch', fetchMock);

    const r = await fetchRegistry();
    expect(r.registry.generatedAt).toBe('fresh2');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetches from GitHub raw, never a CDN', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return okRes(reg('fresh')); }));

    await fetchRegistry({ force: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('raw.githubusercontent.com');
    expect(calls[0]).not.toContain('jsdelivr');
  });
});

describe('revalidateRegistry', () => {
  it('serves the cache first, then the fresh copy — the TTL must not hide an update', async () => {
    // The exact case this exists for: a cache well inside the TTL, holding a
    // registry that has since been corrected upstream. `fetchRegistry` alone
    // would return the stale copy and never hit the network.
    writeCache(NOW, 'cached');
    vi.stubGlobal('fetch', vi.fn(async () => okRes(reg('corrected'))));

    const seen: string[] = [];
    await revalidateRegistry(r => seen.push(r.generatedAt));

    expect(seen).toEqual(['cached', 'corrected']);
  });

  it('emits once when the fresh copy matches the cache — no pointless re-render', async () => {
    writeCache(NOW, 'same');
    vi.stubGlobal('fetch', vi.fn(async () => okRes(reg('same'))));

    const seen: string[] = [];
    await revalidateRegistry(r => seen.push(r.generatedAt));

    expect(seen).toEqual(['same']);
  });

  it('emits once with the network copy when there is no cache', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okRes(reg('first'))));

    const seen: string[] = [];
    await revalidateRegistry(r => seen.push(r.generatedAt));

    expect(seen).toEqual(['first']);
  });

  it('keeps the cached copy when the network fails, and does not emit it twice', async () => {
    writeCache(NOW, 'cached');
    vi.stubGlobal('fetch', vi.fn(async () => failRes()));

    const seen: string[] = [];
    await revalidateRegistry(r => seen.push(r.generatedAt));

    expect(seen).toEqual(['cached']);
  });

  it('never rejects and emits nothing when there is no cache and no network', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => failRes()));

    const seen: string[] = [];
    await expect(revalidateRegistry(r => seen.push(r.generatedAt))).resolves.toBeUndefined();
    expect(seen).toEqual([]);
  });
});
