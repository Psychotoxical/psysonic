/**
 * Theme Store registry client. Reads the auto-generated `registry.json` and each
 * theme's CSS/thumbnail straight from the public `Psysonic/psysonic-themes` repo
 * over GitHub raw (permissive CORS, ~5-minute server cache). The registry is
 * cached in localStorage with a TTL so the store opens instantly and works
 * offline against the last-seen catalogue.
 */

const RAW_BASE = 'https://raw.githubusercontent.com/Psysonic/psysonic-themes/main';
const REGISTRY_URL = `${RAW_BASE}/registry.json`;
const CACHE_KEY = 'psysonic_theme_registry_cache';
// Client-side cache lifetime: the store opens from this copy without a network
// round-trip and falls back to it when offline. The manual refresh button
// bypasses it, and GitHub raw is itself fresh (~5-min server cache).
const TTL_MS = 12 * 60 * 60 * 1000; // 12h

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
  /** ISO date of the last commit touching the theme in the registry repo. */
  updatedAt?: string;
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

/** Absolute GitHub-raw URL for a repo-relative asset path (css / thumbnail). */
export function assetUrl(relPath: string): string {
  return `${RAW_BASE}/${relPath}`;
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
    if (res.ok) {
      const registry = (await res.json()) as Registry;
      writeCache(registry);
      return { registry, stale: false };
    }
  } catch {
    // fall through to the cached copy below
  }
  const cached = readCache();
  if (cached) return { registry: cached.registry, stale: true };
  throw new Error('registry fetch failed');
}

/**
 * Fetch a single theme's CSS text from GitHub raw (repo-relative path). Raw is
 * used rather than a mutable CDN edge so an install or update always gets the
 * current bytes: a stale edge would otherwise store pre-update CSS under the new
 * version label, leaving the theme wrong with no further update to correct it.
 */
export async function fetchThemeCss(relPath: string): Promise<string> {
  const res = await fetch(assetUrl(relPath), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`theme css fetch failed: ${res.status}`);
  return res.text();
}
