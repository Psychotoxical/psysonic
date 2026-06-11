/**
 * Loved-track cache keyed by `${title}::${artist}` — provider-agnostic (the key
 * format predates and survives the Music Network rename). Kept out of the main
 * `psysonic-player` blob so a large queue cannot block writes (thin-state #872).
 *
 * Migration: reads fall back from the current key to the legacy
 * `psysonic_lastfm_loved_cache`, then to the legacy player blob, so no loved
 * state is lost across the Last.fm → Music Network rename.
 */
const CACHE_STORAGE_KEY = 'psysonic_network_loved_cache';
const LEGACY_CACHE_STORAGE_KEY = 'psysonic_lastfm_loved_cache';
const LEGACY_PLAYER_STORAGE_KEY = 'psysonic-player';

function sanitizeCache(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key === 'string' && key.length > 0 && typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

function readKey(key: string): Record<string, boolean> | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const sanitized = sanitizeCache(JSON.parse(raw));
    return Object.keys(sanitized).length > 0 ? sanitized : null;
  } catch {
    return null;
  }
}

function readLegacyCacheFromPlayerBlob(): Record<string, boolean> | null {
  try {
    const raw = window.localStorage.getItem(LEGACY_PLAYER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: { lastfmLovedCache?: unknown; networkLovedCache?: unknown } };
    const cache = parsed.state?.networkLovedCache ?? parsed.state?.lastfmLovedCache;
    if (!cache) return null;
    const sanitized = sanitizeCache(cache);
    return Object.keys(sanitized).length > 0 ? sanitized : null;
  } catch {
    return null;
  }
}

export function readInitialNetworkLovedCache(): Record<string, boolean> {
  if (typeof window === 'undefined') return {};
  return (
    readKey(CACHE_STORAGE_KEY)
    ?? readKey(LEGACY_CACHE_STORAGE_KEY)
    ?? readLegacyCacheFromPlayerBlob()
    ?? {}
  );
}

export function persistNetworkLovedCache(cache: Record<string, boolean>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(sanitizeCache(cache)));
  } catch {
    // best-effort
  }
}
