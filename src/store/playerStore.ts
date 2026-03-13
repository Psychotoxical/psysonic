import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { Howl } from 'howler';
import { buildStreamUrl, getPlayQueue, savePlayQueue, SubsonicSong, reportNowPlaying, scrobbleSong } from '../api/subsonic';
import { useAuthStore } from './authStore';

export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  albumId: string;
  duration: number;
  coverArt?: string;
  track?: number;
  year?: number;
  bitRate?: number;
  suffix?: string;
  userRating?: number;
}

interface PlayerState {
  currentTrack: Track | null;
  queue: Track[];
  queueIndex: number;
  isPlaying: boolean;
  progress: number; // 0–1
  currentTime: number;
  volume: number;
  howl: Howl | null;
  prefetched: Map<string, Howl>;
  scrobbled: boolean;

  // Actions
  playTrack: (track: Track, queue?: Track[]) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  togglePlay: () => void;
  next: () => void;
  previous: () => void;
  seek: (progress: number) => void;
  setVolume: (v: number) => void;
  setProgress: (t: number, duration: number) => void;
  enqueue: (tracks: Track[]) => void;
  clearQueue: () => void;
  prefetchUpcoming: (fromIndex: number, queue: Track[]) => void;
  
  isQueueVisible: boolean;
  toggleQueue: () => void;

  isFullscreenOpen: boolean;
  toggleFullscreen: () => void;
  
  repeatMode: 'off' | 'all' | 'one';
  toggleRepeat: () => void;

  reorderQueue: (startIndex: number, endIndex: number) => void;
  removeTrack: (index: number) => void;
  
  initializeFromServerQueue: () => Promise<void>;

  // Context Menu Global State
  contextMenu: {
    isOpen: boolean;
    x: number;
    y: number;
    item: any;
    type: 'song' | 'album' | 'artist' | 'queue-item' | 'album-song' | null;
    queueIndex?: number; // Only for 'queue-item'
  };
  openContextMenu: (x: number, y: number, item: any, type: 'song' | 'album' | 'artist' | 'queue-item' | 'album-song', queueIndex?: number) => void;
  closeContextMenu: () => void;
}

let progressInterval: ReturnType<typeof setInterval> | null = null;
let seekDebounce: ReturnType<typeof setTimeout> | null = null;

function clearProgress() {
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }
}

// Helper to debounce or fire queue syncs
let syncTimeout: ReturnType<typeof setTimeout> | null = null;
function syncQueueToServer(queue: Track[], currentTrack: Track | null, currentTime: number) {
  if (syncTimeout) clearTimeout(syncTimeout);
  syncTimeout = setTimeout(() => {
    // Collect up to 1000 track IDs just in case it's huge
    const ids = queue.slice(0, 1000).map(t => t.id);
    // Convert currentTime (seconds) to expected format (milliseconds)
    const pos = Math.floor(currentTime * 1000);
    savePlayQueue(ids, currentTrack?.id, pos).catch(err => {
      console.error('Failed to sync play queue to server', err);
    });
  }, 1500); // 1.5s debounce
}

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set, get) => ({
      currentTrack: null,
      queue: [],
      queueIndex: 0,
      isPlaying: false,
      progress: 0,
      currentTime: 0,
      volume: 0.8,
      howl: null,
      prefetched: new Map(),
      scrobbled: false,
      isQueueVisible: true,
      isFullscreenOpen: false,
      repeatMode: 'off',
      contextMenu: { isOpen: false, x: 0, y: 0, item: null, type: null },

      openContextMenu: (x, y, item, type, queueIndex) => set({
        contextMenu: { isOpen: true, x, y, item, type, queueIndex }
      }),
      closeContextMenu: () => set(state => ({
        contextMenu: { ...state.contextMenu, isOpen: false }
      })),

      toggleQueue: () => set((state) => ({ isQueueVisible: !state.isQueueVisible })),
      toggleFullscreen: () => set((state) => ({ isFullscreenOpen: !state.isFullscreenOpen })),

  toggleRepeat: () => set((state) => {
    const modes = ['off', 'all', 'one'] as const;
    const nextIdx = (modes.indexOf(state.repeatMode) + 1) % modes.length;
    return { repeatMode: modes[nextIdx] };
  }),

  stop: () => {
    get().howl?.stop();
    get().howl?.seek(0);
    clearProgress();
    set({ isPlaying: false, progress: 0, currentTime: 0 });
  },

  playTrack: (track, queue) => {
    const state = get();
    // Stop current
    state.howl?.unload();
    clearProgress();

    const newQueue = queue ?? state.queue;
    const idx = newQueue.findIndex(t => t.id === track.id);

    const url = buildStreamUrl(track.id);
    const howl = new Howl({
      src: [url],
      html5: true,
      volume: state.volume,
      onplay: () => {
        set({ isPlaying: true });
        // Subsonic / Navidrome Now Playing
        reportNowPlaying(track.id);

        set({ scrobbled: false });
        progressInterval = setInterval(() => {
          const h = get().howl;
          if (!h) return;
          const cur = typeof h.seek() === 'number' ? h.seek() as number : 0;
          const dur = h.duration() || 1;
          const prog = cur / dur;
          set({ currentTime: cur, progress: prog });

          // Scrobble at 50%
          if (prog >= 0.5 && !get().scrobbled) {
            set({ scrobbled: true });
            const { scrobblingEnabled } = useAuthStore.getState();
            if (scrobblingEnabled) {
              scrobbleSong(track.id, Date.now());
            }
          }
        }, 500);

        // Prefetch next 3
        get().prefetchUpcoming(idx + 1, newQueue);
      },
      onend: () => {
        clearProgress();
        set({ isPlaying: false, progress: 0, currentTime: 0 });
        const { repeatMode, currentTrack, queue } = get();
        if (repeatMode === 'one' && currentTrack) {
          get().playTrack(currentTrack, queue);
        } else {
          get().next();
        }
      },
      onstop: () => {
        clearProgress();
        set({ isPlaying: false });
      },
    });

    howl.play();
    set({ currentTrack: track, queue: newQueue, queueIndex: idx >= 0 ? idx : 0, howl, progress: 0, currentTime: 0 });
    syncQueueToServer(newQueue, track, 0);
  },

  pause: () => {
    get().howl?.pause();
    clearProgress();
    set({ isPlaying: false });
  },

  resume: () => {
    const { howl, currentTrack } = get();
    if (!howl || !currentTrack) return;
    howl.play();
    set({ isPlaying: true });
  },

  togglePlay: () => {
    const { isPlaying } = get();
    isPlaying ? get().pause() : get().resume();
  },

  next: () => {
    const { queue, queueIndex, repeatMode } = get();
    const nextIdx = queueIndex + 1;
    if (nextIdx < queue.length) {
      get().playTrack(queue[nextIdx], queue);
    } else if (repeatMode === 'all' && queue.length > 0) {
      get().playTrack(queue[0], queue);
    }
  },

  previous: () => {
    const { howl, queue, queueIndex, currentTime } = get();
    if (currentTime > 3) {
      howl?.seek(0);
      set({ progress: 0, currentTime: 0 });
      return;
    }
    const prevIdx = queueIndex - 1;
    if (prevIdx >= 0) get().playTrack(queue[prevIdx], queue);
  },

  seek: (progress) => {
    const { howl, currentTrack } = get();
    if (!howl || !currentTrack) return;
    const time = progress * (howl.duration() || currentTrack.duration);
    // Update UI immediately for responsiveness
    set({ progress, currentTime: time });
    // Debounce the actual seek — GStreamer on Linux stalls if two seeks arrive
    // before the first one completes (reproducible after the 2nd seek)
    if (seekDebounce) clearTimeout(seekDebounce);
    seekDebounce = setTimeout(() => {
      get().howl?.seek(time);
      seekDebounce = null;
    }, 100);
  },

  setVolume: (v) => {
    const clamped = Math.max(0, Math.min(1, v));
    get().howl?.volume(clamped);
    set({ volume: clamped });
  },

  setProgress: (t, duration) => {
    set({ currentTime: t, progress: duration > 0 ? t / duration : 0 });
  },

  enqueue: (tracks) => {
    set(state => {
      const newQueue = [...state.queue, ...tracks];
      syncQueueToServer(newQueue, state.currentTrack, state.currentTime);
      return { queue: newQueue };
    });
  },

  clearQueue: () => {
    get().howl?.unload();
    clearProgress();
    set({ queue: [], queueIndex: 0, currentTrack: null, isPlaying: false, progress: 0, currentTime: 0, howl: null });
    syncQueueToServer([], null, 0);
  },

  // Internal: prefetch next N tracks
  prefetchUpcoming: (fromIndex: number, queue: Track[]) => {
    const { prefetched } = get();
    // Unload and clear old prefetches to prevent memory leaks
    prefetched.forEach((h, id) => {
      h.unload();
    });
    prefetched.clear();

    const toFetch = queue.slice(fromIndex, fromIndex + 3);
    toFetch.forEach(track => {
      const url = buildStreamUrl(track.id);
      const h = new Howl({ src: [url], html5: true, preload: true, autoplay: false });
      prefetched.set(track.id, h);
    });
    set({ prefetched: new Map(prefetched) });
  },
  // Playlist management
  reorderQueue: (startIndex: number, endIndex: number) => {
    const { queue, queueIndex, currentTrack } = get();
    const result = Array.from(queue);
    const [removed] = result.splice(startIndex, 1);
    result.splice(endIndex, 0, removed);
    
    // Update queueIndex if the currently playing track moved
    let newIndex = queueIndex;
    if (currentTrack) {
      newIndex = result.findIndex(t => t.id === currentTrack.id);
    }
    set({ queue: result, queueIndex: Math.max(0, newIndex) });
    syncQueueToServer(result, currentTrack, get().currentTime);
  },
  
  removeTrack: (index: number) => {
    const { queue, queueIndex } = get();
    const newQueue = [...queue];
    newQueue.splice(index, 1);
    // If we removed the currently playing track, stop playback? 
    // Usually wait until it finishes or user skips. We'll just update state.
    set({ queue: newQueue, queueIndex: Math.min(queueIndex, newQueue.length - 1) });
    syncQueueToServer(newQueue, get().currentTrack, get().currentTime);
  },
  
  initializeFromServerQueue: async () => {
    try {
      const q = await getPlayQueue();
      if (q.songs.length > 0) {
        const mappedTracks: Track[] = q.songs.map((s: SubsonicSong) => ({
          id: s.id, title: s.title, artist: s.artist, album: s.album,
          albumId: s.albumId, duration: s.duration, coverArt: s.coverArt, track: s.track,
          year: s.year, bitRate: s.bitRate, suffix: s.suffix, userRating: s.userRating,
        }));
        
        let currentTrack = mappedTracks[0];
        let queueIndex = 0;
        
        if (q.current) {
          const idx = mappedTracks.findIndex(t => t.id === q.current);
          if (idx >= 0) {
            currentTrack = mappedTracks[idx];
            queueIndex = idx;
          }
        }
        
        set({ 
          queue: mappedTracks, 
          queueIndex,
          currentTrack,
          // Convert position from ms to s
          currentTime: q.position ? q.position / 1000 : 0
        });
      }
    } catch (e) {
      console.error('Failed to initialize queue from server', e);
    }
  },
  


}), {
  name: 'psysonic-player',
  storage: createJSONStorage(() => localStorage),
  partialize: (state) => ({
    volume: state.volume,
    repeatMode: state.repeatMode,
  } as Partial<PlayerState>),
}));
