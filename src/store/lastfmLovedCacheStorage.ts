/**
 * Last.fm loved-track cache keyed by `${title}::${artist}`. Kept out of the
 * main `psysonic-player` blob so a large queue cannot block writes (thin-state
 * #872 quota issue). Same split-storage pattern as `playerPrefsStorage.ts`.
 */
const CACHE_STORAGE_KEY = 'psysonic_lastfm_loved_cache';
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

function readLegacyCacheFromPlayerBlob(): Record<string, boolean> | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(LEGACY_PLAYER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: { lastfmLovedCache?: unknown } };
    const cache = parsed.state?.lastfmLovedCache;
    if (!cache) return null;
    const sanitized = sanitizeCache(cache);
    return Object.keys(sanitized).length > 0 ? sanitized : null;
  } catch {
    return null;
  }
}

export function readInitialLastfmLovedCache(): Record<string, boolean> {
  if (typeof window === 'undefined') return {};

  try {
    const raw = window.localStorage.getItem(CACHE_STORAGE_KEY);
    if (raw) return sanitizeCache(JSON.parse(raw));
  } catch {
    // fall through to legacy blob / empty
  }

  return readLegacyCacheFromPlayerBlob() ?? {};
}

export function persistLastfmLovedCache(cache: Record<string, boolean>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(sanitizeCache(cache)));
  } catch {
    // best-effort
  }
}
