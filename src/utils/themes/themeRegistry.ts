/**
 * Theme Store registry client. Reads the auto-generated `registry.json` from the
 * public `Psysonic/psysonic-themes` repo via the jsDelivr CDN (CORS-enabled,
 * globally cached). The registry is cached in localStorage with a TTL so the
 * store opens instantly and works offline against the last-seen catalogue.
 */

const CDN_BASE = 'https://cdn.jsdelivr.net/gh/Psysonic/psysonic-themes@main';
const REGISTRY_URL = `${CDN_BASE}/registry.json`;
// GitHub raw serves with a ~5-minute cache (vs jsDelivr's up-to-12h @main edge)
// and permissive CORS. Used only on a manual refresh so freshly merged themes
// appear without waiting on — or purging — the shared CDN edge.
const RAW_REGISTRY_URL = 'https://raw.githubusercontent.com/Psysonic/psysonic-themes/main/registry.json';
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
  /** True when the theme defines @keyframes (used for the CPU-load warning). */
  animated?: boolean;
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
  // On a manual refresh, try GitHub raw first (fresher) then fall back to the
  // jsDelivr CDN; normal loads use the CDN only.
  const sources = opts?.force ? [RAW_REGISTRY_URL, REGISTRY_URL] : [REGISTRY_URL];
  for (const url of sources) {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) continue;
      const registry = (await res.json()) as Registry;
      writeCache(registry);
      return { registry, stale: false };
    } catch {
      // try the next source
    }
  }
  const cached = readCache();
  if (cached) return { registry: cached.registry, stale: true };
  throw new Error('registry fetch failed');
}

/** Fetch a single theme's CSS text from the CDN (repo-relative path). */
export async function fetchThemeCss(relPath: string): Promise<string> {
  const res = await fetch(cdnUrl(relPath), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`theme css fetch failed: ${res.status}`);
  return res.text();
}
