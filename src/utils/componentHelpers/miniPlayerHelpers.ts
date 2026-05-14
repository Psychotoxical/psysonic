import { usePlayerStore } from '../../store/playerStore';
import type { MiniSyncPayload, MiniTrackInfo } from '../miniPlayerBridge';

export const COLLAPSED_SIZE = { w: 340, h: 260 };
export const EXPANDED_SIZE  = { w: 340, h: 500 };
// Minimum window dimensions per state. When the queue is open the floor must
// keep at least two queue rows visible; a stricter min would let the user
// collapse the queue area to nothing while it's still toggled on.
export const COLLAPSED_MIN  = { w: 320, h: 240 };
export const EXPANDED_MIN   = { w: 320, h: 340 };

// Persist the expanded-window height so reopening the queue restores the
// user's preferred size instead of snapping back to EXPANDED_SIZE.h.
export const EXPANDED_H_KEY = 'psysonic_mini_expanded_h';
export function readStoredExpandedHeight(): number {
  try {
    const raw = localStorage.getItem(EXPANDED_H_KEY);
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n >= EXPANDED_MIN.h) return n;
    }
  } catch {}
  return EXPANDED_SIZE.h;
}

// Persist whether the queue panel was open so the next launch restores
// the same state. Same scope as the height: localStorage of the mini
// webview (shared across mini sessions, separate from the main store).
export const QUEUE_OPEN_KEY = 'psysonic_mini_queue_open';
export function readQueueOpen(): boolean {
  try { return localStorage.getItem(QUEUE_OPEN_KEY) === '1'; } catch { return false; }
}

export function toMini(t: any): MiniTrackInfo {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    albumId: t.albumId,
    artistId: t.artistId,
    coverArt: t.coverArt,
    duration: t.duration,
    starred: !!t.starred,
    year: t.year,
  };
}

/**
 * Hydrate from the persisted playerStore so initial paint shows real content
 * instead of "—" while we wait for the mini:sync event from the main window.
 * The persisted state covers the cold-start window (webview boot + bundle).
 */
export function initialSnapshot(): MiniSyncPayload {
  try {
    const s = usePlayerStore.getState();
    return {
      track: s.currentTrack ? toMini(s.currentTrack) : null,
      queue: (s.queue ?? []).map(toMini),
      queueIndex: s.queueIndex ?? 0,
      isPlaying: s.isPlaying,
      volume: s.volume ?? 1,
      gaplessEnabled: false,
      crossfadeEnabled: false,
      infiniteQueueEnabled: false,
      isMobile: false,
    };
  } catch {
    return {
      track: null, queue: [], queueIndex: 0, isPlaying: false,
      volume: 1, gaplessEnabled: false, crossfadeEnabled: false,
      infiniteQueueEnabled: false, isMobile: false,
    };
  }
}
