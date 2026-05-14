// Module-level TTL caches (shared across mounts).
// Used by NowPlaying subcomponents to avoid hammering Subsonic / Last.fm /
// Bandsintown on every track / artist change.

export const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry<T> { value: T; ts: number; }

export function makeCache<T>() {
  const map = new Map<string, CacheEntry<T>>();
  return {
    get(key: string): T | undefined {
      const e = map.get(key);
      if (!e) return undefined;
      if (Date.now() - e.ts > CACHE_TTL_MS) { map.delete(key); return undefined; }
      return e.value;
    },
    set(key: string, value: T) { map.set(key, { value, ts: Date.now() }); },
  };
}
