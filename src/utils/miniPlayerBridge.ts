import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen, emitTo } from '@tauri-apps/api/event';
import { usePlayerStore } from '../store/playerStore';
import { useAuthStore } from '../store/authStore';
import { setTransitionMode, type TransitionMode } from './playback/playbackTransition';
import { resolveQueueTrack } from './library/queueTrackView';
import type { SubsonicOpenArtistRef } from '../api/subsonicTypes';
import type { Track } from '../store/playerStoreTypes';

export const MINI_WINDOW_LABEL = 'mini';

export interface MiniTrackInfo {
  id: string;
  title: string;
  artist: string;
  /** OpenSubsonic performer refs when the main queue carried them. */
  artists?: SubsonicOpenArtistRef[];
  album: string;
  albumId?: string;
  artistId?: string;
  coverArt?: string;
  duration?: number;
  starred?: boolean;
  year?: number;
}

export interface MiniSyncPayload {
  track: MiniTrackInfo | null;
  queue: MiniTrackInfo[];
  queueIndex: number;
  queueServerId: string | null;
  isPlaying: boolean;
  volume: number;
  gaplessEnabled: boolean;
  crossfadeEnabled: boolean;
  crossfadeSecs: number;
  crossfadeTrimSilence: boolean;
  infiniteQueueEnabled: boolean;
  isMobile: false;
}

export type MiniControlAction =
  | 'toggle'
  | 'next'
  | 'prev'
  | 'show-main';

function toMini(t: Track): MiniTrackInfo {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    artists: Array.isArray(t.artists) && t.artists.length > 0 ? t.artists : undefined,
    album: t.album,
    albumId: t.albumId,
    artistId: t.artistId,
    coverArt: t.coverArt,
    duration: t.duration,
    starred: !!t.starred,
    year: t.year,
  };
}

/** Cap the queue pushed to the mini at ±100 tracks around the playing song — a
 *  50k Artist-Radio queue must not serialize in full over IPC on every push. The
 *  mini stays slice-relative (no component change); control events (jump/reorder/
 *  remove) are translated back to absolute indices via {@link miniWindowStart}. */
const MINI_QUEUE_HALF = 100;
let miniWindowStart = 0;

function snapshot(): MiniSyncPayload {
  const s = usePlayerStore.getState();
  const a = useAuthStore.getState();
  const idx = s.queueIndex ?? 0;
  const start = Math.max(0, idx - MINI_QUEUE_HALF);
  // Thin-state: resolve the windowed slice (resolver cache → placeholder).
  const windowed = (s.queueItems ?? [])
    .slice(start, idx + MINI_QUEUE_HALF + 1)
    .map(r => resolveQueueTrack(r));
  miniWindowStart = start;
  return {
    track: s.currentTrack ? toMini(s.currentTrack) : null,
    queue: windowed.map(toMini),
    queueIndex: idx - start, // local position within the windowed slice
    queueServerId: s.queueServerId ?? null,
    isPlaying: s.isPlaying,
    volume: s.volume,
    gaplessEnabled: !!a.gaplessEnabled,
    crossfadeEnabled: !!a.crossfadeEnabled,
    crossfadeSecs: a.crossfadeSecs,
    crossfadeTrimSilence: !!a.crossfadeTrimSilence,
    infiniteQueueEnabled: !!a.infiniteQueueEnabled,
    isMobile: false,
  };
}

/**
 * Bridge initialised on the main window. Pushes track/state changes to the
 * mini window whenever they matter, and handles control events coming back
 * from the mini window.
 *
 * Returns a cleanup function.
 */
export function initMiniPlayerBridgeOnMain(): () => void {
  // Only run on the main window
  if (getCurrentWindow().label !== 'main') return () => {};

  // Push state to the mini window on every relevant store change.
  let last = '';
  const push = () => {
    const payload = snapshot();
    const queueIds = payload.queue.map(q => q.id).join(',');
    const key = [
      payload.track?.id ?? '',
      payload.isPlaying,
      payload.track?.starred ?? '',
      (payload.track?.artists ?? []).map((a: SubsonicOpenArtistRef) => a.id ?? a.name).join('|'),
      payload.queueIndex,
      payload.queueServerId ?? '',
      payload.volume,
      payload.gaplessEnabled,
      payload.crossfadeEnabled,
      payload.crossfadeSecs,
      payload.crossfadeTrimSilence,
      payload.infiniteQueueEnabled,
      queueIds,
    ].join('|');
    if (key === last) return;
    last = key;
    emitTo(MINI_WINDOW_LABEL, 'mini:sync', payload).catch(() => {});
  };

  const unsub = usePlayerStore.subscribe((state, prev) => {
    if (state.currentTrack?.id !== prev.currentTrack?.id
      || state.isPlaying !== prev.isPlaying
      || state.currentTrack?.starred !== prev.currentTrack?.starred
      || state.queueIndex !== prev.queueIndex
      || state.queueItems !== prev.queueItems
      || state.queueServerId !== prev.queueServerId
      || state.volume !== prev.volume) {
      push();
    }
  });

  // Toolbar toggles (gapless / crossfade / infinite queue) live in authStore;
  // subscribe so changes from the main window propagate to the mini.
  const unsubAuth = useAuthStore.subscribe((state, prev) => {
    if (state.gaplessEnabled !== prev.gaplessEnabled
      || state.crossfadeEnabled !== prev.crossfadeEnabled
      || state.crossfadeSecs !== prev.crossfadeSecs
      || state.crossfadeTrimSilence !== prev.crossfadeTrimSilence
      || state.infiniteQueueEnabled !== prev.infiniteQueueEnabled) {
      push();
    }
  });

  // Push an initial snapshot whenever a new mini window announces itself.
  const readyUnlisten = listen('mini:ready', () => {
    last = '';
    push();
  });

  // Receive control actions from the mini window.
  const controlUnlisten = listen<MiniControlAction>('mini:control', (e) => {
    const action = e.payload;
    const store = usePlayerStore.getState();
    switch (action) {
      case 'toggle':   store.togglePlay(); break;
      case 'next':     store.next(true); break;
      case 'prev':     store.previous(); break;
      case 'show-main': {
        const w = getCurrentWindow();
        w.unminimize().catch(() => {});
        w.show().catch(() => {});
        w.setFocus().catch(() => {});
        break;
      }
    }
  });

  // Jump to a specific queue index. The mini sends a slice-relative index; add
  // the window offset from the last push to land on the absolute queue position.
  const jumpUnlisten = listen<{ index: number }>('mini:jump', (e) => {
    const store = usePlayerStore.getState();
    const idx = (e.payload?.index ?? -1) + miniWindowStart;
    if (idx < 0 || idx >= store.queueItems.length) return;
    const ref = store.queueItems[idx];
    if (ref) {
      // Resolve the target ref; pass undefined so playTrack keeps the canonical
      // queue and just jumps to this slot.
      store.playTrack(resolveQueueTrack(ref), undefined, true, false, idx);
    }
  });

  // PsyDnD reorder forwarded from the mini queue (slice-relative → absolute).
  const reorderUnlisten = listen<{ from: number; to: number }>('mini:reorder', (e) => {
    const store = usePlayerStore.getState();
    const raw = e.payload ?? { from: -1, to: -1 };
    const from = raw.from + miniWindowStart;
    const to = raw.to + miniWindowStart;
    if (from < 0 || from >= store.queueItems.length) return;
    if (to < 0 || to > store.queueItems.length) return;
    if (from === to) return;
    store.reorderQueue(from, to);
  });

  // Remove a track at index (context menu → "Remove from queue"; slice-relative).
  const removeUnlisten = listen<{ index: number }>('mini:remove', (e) => {
    const store = usePlayerStore.getState();
    const idx = (e.payload?.index ?? -1) + miniWindowStart;
    if (idx < 0 || idx >= store.queueItems.length) return;
    store.removeTrack(idx);
  });

  // Navigate the main app to a route. Used by mini context menu actions
  // like "Open Album" / "Go to Artist" — those need the full main UI.
  const navigateUnlisten = listen<{ to: string }>('mini:navigate', (e) => {
    const to = e.payload?.to;
    if (!to) return;
    // Surface the main window first so the navigation is visible.
    const w = getCurrentWindow();
    w.unminimize().catch(() => {});
    w.show().catch(() => {});
    w.setFocus().catch(() => {});
    // React Router lives in main; route via a custom event the AppShell
    // picks up (defined in App.tsx).
    window.dispatchEvent(new CustomEvent('psy:navigate', { detail: { to } }));
  });

  // Volume changes from the mini's vertical slider.
  const volumeUnlisten = listen<{ value: number }>('mini:set-volume', (e) => {
    const v = e.payload?.value;
    if (typeof v !== 'number') return;
    usePlayerStore.getState().setVolume(Math.max(0, Math.min(1, v)));
  });

  // Toolbar actions from the mini.
  const shuffleUnlisten = listen('mini:shuffle', () => {
    usePlayerStore.getState().shuffleQueue();
  });

  const undoQueueUnlisten = listen('mini:undo-queue', () => {
    usePlayerStore.getState().undoLastQueueEdit();
  });

  const redoQueueUnlisten = listen('mini:redo-queue', () => {
    usePlayerStore.getState().redoLastQueueEdit();
  });

  // Gapless ↔ Crossfade are mutually exclusive. Bridge handles the exclusion
  // so the mini doesn't need to know about both states to act.
  const transitionModeUnlisten = listen<{ value: string }>('mini:set-transition-mode', (e) => {
    const v = e.payload?.value;
    const modes: TransitionMode[] = ['none', 'gapless', 'crossfade', 'autodj'];
    if (modes.includes(v as TransitionMode)) setTransitionMode(v as TransitionMode);
  });

  const crossfadeSecsUnlisten = listen<{ value: number }>('mini:set-crossfade-secs', (e) => {
    const v = e.payload?.value;
    if (typeof v !== 'number' || !Number.isFinite(v)) return;
    useAuthStore.getState().setCrossfadeSecs(Math.max(0.1, Math.min(10, v)));
  });

  const infiniteQueueUnlisten = listen<{ value: boolean }>('mini:set-infinite-queue', (e) => {
    const v = !!e.payload?.value;
    useAuthStore.getState().setInfiniteQueueEnabled(v);
  });

  // Open the SongInfo modal in main for a given track id.
  const songInfoUnlisten = listen<{ id: string }>('mini:song-info', (e) => {
    const id = e.payload?.id;
    if (!id) return;
    const w = getCurrentWindow();
    w.unminimize().catch(() => {});
    w.show().catch(() => {});
    w.setFocus().catch(() => {});
    usePlayerStore.getState().openSongInfo(id);
  });

  return () => {
    unsub();
    unsubAuth();
    readyUnlisten.then(fn => fn()).catch(() => {});
    controlUnlisten.then(fn => fn()).catch(() => {});
    jumpUnlisten.then(fn => fn()).catch(() => {});
    reorderUnlisten.then(fn => fn()).catch(() => {});
    removeUnlisten.then(fn => fn()).catch(() => {});
    navigateUnlisten.then(fn => fn()).catch(() => {});
    volumeUnlisten.then(fn => fn()).catch(() => {});
    shuffleUnlisten.then(fn => fn()).catch(() => {});
    undoQueueUnlisten.then(fn => fn()).catch(() => {});
    redoQueueUnlisten.then(fn => fn()).catch(() => {});
    transitionModeUnlisten.then(fn => fn()).catch(() => {});
    crossfadeSecsUnlisten.then(fn => fn()).catch(() => {});
    infiniteQueueUnlisten.then(fn => fn()).catch(() => {});
    songInfoUnlisten.then(fn => fn()).catch(() => {});
  };
}
