/**
 * Theme Store registry client. Reads the auto-generated `registry.json` from the
 * public `Psysonic/psysonic-themes` repo via the jsDelivr CDN (CORS-enabled,
 * globally cached). The registry is cached in localStorage with a TTL so the
 * store opens instantly and works offline against the last-seen catalogue.
 */

const CDN_BASE = 'https://cdn.jsdelivr.net/gh/Psysonic/psysonic-themes@main';
const REGISTRY_URL = `${CDN_BASE}/registry.json`;
const CACHE_KEY = 'psysonic_theme_registry_cache';
const TTL_MS = 12 * 60 * 60 * 1000; // 12h — matches jsDelivr's @main edge cache

export interface RegistryTheme {
  id: string;
  name: string;
  author: string;
  version: string;
  description: string;
  mode: 'dark' | 'light';
  tags?: string[];
  /** Repo-relative path to the theme's CSS. */
  css: string;
  /** Repo-relative path to the thumbnail. */
  thumbnail: string;
}

export interface Registry {
  schemaVersion: number;
  generatedAt: string;
  themes: RegistryTheme[];
}

interface CacheEnvelope {
  ts: number;
  registry: Registry;
}

/** Absolute CDN URL for a repo-relative path (css / thumbnail). */
export function cdnUrl(relPath: string): string {
  return `${CDN_BASE}/${relPath}`;
}

function readCache(): CacheEnvelope | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const env = JSON.parse(raw) as CacheEnvelope;
    if (!env || typeof env.ts !== 'number' || !env.registry) return null;
    return env;
  } catch {
    return null;
  }
}

function writeCache(registry: Registry): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), registry }));
  } catch {
    // Quota or serialization failure is non-fatal — we just re-fetch next time.
  }
}

/** Last-seen registry regardless of age (for offline use). */
export function getCachedRegistry(): Registry | null {
  return readCache()?.registry ?? null;
}

export interface FetchRegistryResult {
  registry: Registry;
  /** True when the network fetch failed and we served a cached copy instead. */
  stale: boolean;
}

/**
 * Fetch the registry. Returns the cached copy if it is still fresh, unless
 * `force` is set (manual refresh). Falls back to a cached copy if the network
 * fetch fails (flagged `stale: true`) so the store keeps working offline.
 */
export async function fetchRegistry(opts?: { force?: boolean }): Promise<FetchRegistryResult> {
  if (!opts?.force) {
    const cached = readCache();
    if (cached && Date.now() - cached.ts < TTL_MS) return { registry: cached.registry, stale: false };
  }
  try {
    const res = await fetch(REGISTRY_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`registry fetch failed: ${res.status}`);
    const registry = (await res.json()) as Registry;
    writeCache(registry);
    return { registry, stale: false };
  } catch (err) {
    const cached = readCache();
    if (cached) return { registry: cached.registry, stale: true };
    throw err;
  }
}

/** Fetch a single theme's CSS text from the CDN (repo-relative path). */
export async function fetchThemeCss(relPath: string): Promise<string> {
  const res = await fetch(cdnUrl(relPath), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`theme css fetch failed: ${res.status}`);
  return res.text();
}
