import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen, emitTo } from '@tauri-apps/api/event';
import { usePlayerStore } from '../store/playerStore';
import { useAuthStore } from '../store/authStore';

export const MINI_WINDOW_LABEL = 'mini';

export interface MiniTrackInfo {
  id: string;
  title: string;
  artist: string;
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
  isPlaying: boolean;
  volume: number;
  gaplessEnabled: boolean;
  crossfadeEnabled: boolean;
  infiniteQueueEnabled: boolean;
  isMobile: false;
}

export type MiniControlAction =
  | 'toggle'
  | 'next'
  | 'prev'
  | 'show-main';

function toMini(t: any): MiniTrackInfo {
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

function snapshot(): MiniSyncPayload {
  const s = usePlayerStore.getState();
  const a = useAuthStore.getState();
  return {
    track: s.currentTrack ? toMini(s.currentTrack) : null,
    queue: (s.queue ?? []).map(toMini),
    queueIndex: s.queueIndex ?? 0,
    isPlaying: s.isPlaying,
    volume: s.volume,
    gaplessEnabled: !!a.gaplessEnabled,
    crossfadeEnabled: !!a.crossfadeEnabled,
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
      payload.queueIndex,
      payload.volume,
      payload.gaplessEnabled,
      payload.crossfadeEnabled,
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
      || state.queue !== prev.queue
      || state.volume !== prev.volume) {
      push();
    }
  });

  // Toolbar toggles (gapless / crossfade / infinite queue) live in authStore;
  // subscribe so changes from the main window propagate to the mini.
  const unsubAuth = useAuthStore.subscribe((state, prev) => {
    if (state.gaplessEnabled !== prev.gaplessEnabled
      || state.crossfadeEnabled !== prev.crossfadeEnabled
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

  // Jump to a specific queue index.
  const jumpUnlisten = listen<{ index: number }>('mini:jump', (e) => {
    const store = usePlayerStore.getState();
    const idx = e.payload?.index ?? -1;
    if (idx < 0 || idx >= store.queue.length) return;
    const track = store.queue[idx];
    if (track) store.playTrack(track, store.queue, true);
  });

  // PsyDnD reorder forwarded from the mini queue.
  const reorderUnlisten = listen<{ from: number; to: number }>('mini:reorder', (e) => {
    const store = usePlayerStore.getState();
    const { from, to } = e.payload ?? { from: -1, to: -1 };
    if (from < 0 || from >= store.queue.length) return;
    if (to < 0 || to > store.queue.length) return;
    if (from === to) return;
    store.reorderQueue(from, to);
  });

  // Remove a track at index (context menu → "Remove from queue").
  const removeUnlisten = listen<{ index: number }>('mini:remove', (e) => {
    const store = usePlayerStore.getState();
    const idx = e.payload?.index ?? -1;
    if (idx < 0 || idx >= store.queue.length) return;
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
  const gaplessUnlisten = listen<{ value: boolean }>('mini:set-gapless', (e) => {
    const v = !!e.payload?.value;
    const a = useAuthStore.getState();
    if (v) a.setCrossfadeEnabled(false);
    a.setGaplessEnabled(v);
  });

  const crossfadeUnlisten = listen<{ value: boolean }>('mini:set-crossfade', (e) => {
    const v = !!e.payload?.value;
    const a = useAuthStore.getState();
    if (v) a.setGaplessEnabled(false);
    a.setCrossfadeEnabled(v);
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
    gaplessUnlisten.then(fn => fn()).catch(() => {});
    crossfadeUnlisten.then(fn => fn()).catch(() => {});
    infiniteQueueUnlisten.then(fn => fn()).catch(() => {});
    songInfoUnlisten.then(fn => fn()).catch(() => {});
  };
}
