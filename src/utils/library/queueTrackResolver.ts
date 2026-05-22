import { libraryGetTracksBatch, type TrackRefDto } from '../../api/library';
import { getSong } from '../../api/subsonicLibrary';
import { usePlayerStore } from '../../store/playerStore';
import type { QueueItemRef, Track } from '../../store/playerStoreTypes';
import { songToTrack } from '../playback/songToTrack';
import { trackToSong } from './advancedSearchLocal';
import { libraryIsReady } from './libraryReady';

/**
 * Queue track resolver (thin-state phase 2). Resolves `QueueItemRef`s to full
 * `Track`s on demand — index batch (`library_get_tracks_batch`, ≤100/call) →
 * network `getSong` fallback (P8) — into a bounded LRU cache. The cache holds
 * raw tracks; session star/rating overrides (F4) are merged on read via
 * {@link applyQueueOverrides}. Selectors read synchronously from the cache and
 * subscribe to {@link subscribeQueueResolver} to re-render as fetches land.
 *
 * Phase 2a: standalone module + tests, not yet wired into the store/UI.
 */

const CACHE_CAP = 500;
/** `library_get_tracks_batch` cap (spec §8.6). */
const BATCH = 100;
/** Prefetch window around the visible range (spec §resolver-contract). */
const PREFETCH_BACK = 50;
const PREFETCH_AHEAD = 200;

const refKey = (r: { serverId: string; trackId: string }) => `${r.serverId}:${r.trackId}`;

// LRU cache: refKey → raw Track (no session overrides).
const cache = new Map<string, Track>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** Subscribe to cache changes (for `useSyncExternalStore` selectors). */
export function subscribeQueueResolver(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function cacheTouch(key: string): Track | undefined {
  const t = cache.get(key);
  if (t !== undefined) {
    cache.delete(key);
    cache.set(key, t); // move to most-recent
  }
  return t;
}

function cacheSet(key: string, track: Track): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, track);
  while (cache.size > CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function carryFlags(track: Track, ref: QueueItemRef | undefined): Track {
  if (ref?.autoAdded) track.autoAdded = true;
  if (ref?.radioAdded) track.radioAdded = true;
  if (ref?.playNextAdded) track.playNextAdded = true;
  return track;
}

/** Synchronous cache read (no fetch); undefined on miss. */
export function getCachedTrack(ref: QueueItemRef): Track | undefined {
  return cacheTouch(refKey(ref));
}

/** Lightweight placeholder shown until a ref resolves. */
export function placeholderTrack(ref: QueueItemRef): Track {
  return {
    id: ref.trackId,
    title: '…',
    artist: '',
    album: '',
    albumId: '',
    duration: 0,
    autoAdded: ref.autoAdded,
    radioAdded: ref.radioAdded,
    playNextAdded: ref.playNextAdded,
  };
}

/** Merge session star/rating overrides (F4) onto a resolved track. */
export function applyQueueOverrides(track: Track): Track {
  const s = usePlayerStore.getState();
  const hasStar = track.id in s.starredOverrides;
  const hasRating = track.id in s.userRatingOverrides;
  if (!hasStar && !hasRating) return track;
  const next = { ...track };
  if (hasStar) {
    next.starred = s.starredOverrides[track.id] ? (track.starred ?? new Date().toISOString()) : undefined;
  }
  if (hasRating) next.userRating = s.userRatingOverrides[track.id];
  return next;
}

/** Seed the cache with already-known tracks (e.g. on enqueue) — no fetch. */
export function seedQueueResolver(serverId: string, tracks: Track[]): void {
  if (tracks.length === 0) return;
  for (const t of tracks) cacheSet(refKey({ serverId, trackId: t.id }), t);
  notify();
}

/**
 * Resolve a batch of refs into the cache: index batch (per server, when ready)
 * then network fallback for whatever the index lacks. Skips refs already cached
 * or in flight. Notifies once if anything changed.
 */
export async function resolveBatch(refs: QueueItemRef[]): Promise<void> {
  const missing = refs.filter(r => {
    const k = refKey(r);
    return !cache.has(k) && !inFlight.has(k);
  });
  if (missing.length === 0) return;
  for (const r of missing) inFlight.add(refKey(r));

  let changed = false;
  try {
    const byServer = new Map<string, QueueItemRef[]>();
    for (const r of missing) {
      const arr = byServer.get(r.serverId) ?? [];
      arr.push(r);
      byServer.set(r.serverId, arr);
    }

    for (const [serverId, serverRefs] of byServer) {
      if (!serverId) continue;
      const stillMissing = new Set(serverRefs.map(r => r.trackId));
      const refByTrack = new Map(serverRefs.map(r => [r.trackId, r]));

      if (await libraryIsReady(serverId)) {
        for (let i = 0; i < serverRefs.length; i += BATCH) {
          const chunk: TrackRefDto[] = serverRefs
            .slice(i, i + BATCH)
            .map(r => ({ serverId, trackId: r.trackId }));
          try {
            const dtos = await libraryGetTracksBatch(chunk);
            for (const d of dtos) {
              const track = carryFlags(songToTrack(trackToSong(d)), refByTrack.get(d.id));
              cacheSet(refKey({ serverId, trackId: d.id }), track);
              stillMissing.delete(d.id);
              changed = true;
            }
          } catch { /* fall through to network */ }
        }
      }

      // Network fallback (P8) for refs the index couldn't serve.
      for (const trackId of stillMissing) {
        try {
          const song = await getSong(trackId);
          if (song) {
            const track = carryFlags(songToTrack(song), refByTrack.get(trackId));
            cacheSet(refKey({ serverId, trackId }), track);
            changed = true;
          }
        } catch { /* leave as placeholder */ }
      }
    }
  } finally {
    for (const r of missing) inFlight.delete(refKey(r));
    if (changed) notify();
  }
}

/** Resolve the visible range plus the prefetch window around it. */
export function resolveVisibleRange(refs: QueueItemRef[], fromIdx: number, toIdx: number): void {
  const start = Math.max(0, fromIdx - PREFETCH_BACK);
  const end = Math.min(refs.length, toIdx + PREFETCH_AHEAD + 1);
  if (end > start) void resolveBatch(refs.slice(start, end));
}

/** Drop cached entries for a track id (e.g. after a star/rating sync succeeds,
 *  so the next read re-fetches the server truth). */
export function invalidateQueueResolver(trackId: string): void {
  let changed = false;
  for (const key of [...cache.keys()]) {
    if (key.endsWith(`:${trackId}`)) {
      cache.delete(key);
      changed = true;
    }
  }
  if (changed) notify();
}

/** Test-only: clear cache + in-flight set. */
export function _resetQueueResolverForTest(): void {
  cache.clear();
  inFlight.clear();
}
