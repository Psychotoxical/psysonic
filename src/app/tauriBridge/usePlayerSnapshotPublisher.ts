import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getPlaybackProgressSnapshot } from '@/features/playback/store/playbackProgress';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useAuthStore } from '@/store/authStore';
import { resolveQueueTrack } from '@/features/playback/store/queueTrackView';

/** Half-width of the CLI snapshot queue window (thin-state — like the mini
 *  bridge, the full 50k queue must not serialize over IPC on every change). */
const SNAPSHOT_QUEUE_HALF = 100;

/** `psysonic --info`: publishes a JSON snapshot under XDG_RUNTIME_DIR (Rust
 * writes atomically). Coalesces store changes through a 200 ms debounce and
 * heartbeats so an idle player still refreshes the file periodically. */
export function usePlayerSnapshotPublisher() {
  useEffect(() => {
    let tid: ReturnType<typeof setTimeout> | undefined;
    let lastPublishAt = 0;
    let lastStableKey = '';
    let lastPlaying = false;
    const SNAPSHOT_PLAYING_HEARTBEAT_MS = 4000;
    const SNAPSHOT_IDLE_HEARTBEAT_MS = 15000;
    const publish = () => {
      const s = usePlayerStore.getState();
      const auth = useAuthStore.getState();
      const sid = auth.activeServerId;
      const selected = sid ? (auth.musicLibraryFilterByServer[sid] ?? 'all') : 'all';
      const ct = s.currentTrack;
      const currentTrackUserRating =
        ct != null ? (s.userRatingOverrides[ct.id] ?? ct.userRating ?? null) : null;
      const currentTrackStarred =
        ct != null
          ? (ct.id in s.starredOverrides ? s.starredOverrides[ct.id] : Boolean(ct.starred))
          : null;
      // Thin-state: resolve only a window around the playing track (resolver
      // cache → placeholder) instead of the whole 50k queue. `queue_length`
      // stays the true total; `queue_index` is remapped into the window.
      const total = s.queueItems.length;
      const winStart = Math.max(0, s.queueIndex - SNAPSHOT_QUEUE_HALF);
      const winEnd = Math.min(total, s.queueIndex + SNAPSHOT_QUEUE_HALF + 1);
      const windowedQueue = s.queueItems.slice(winStart, winEnd).map(r => resolveQueueTrack(r));
      const snapshot = {
        current_track: s.currentTrack,
        current_radio: s.currentRadio,
        queue: windowedQueue,
        queue_index: s.queueIndex - winStart,
        queue_length: total,
        is_playing: s.isPlaying,
        current_time: getPlaybackProgressSnapshot().currentTime,
        volume: s.volume,
        repeat_mode: s.repeatMode,
        current_track_user_rating: currentTrackUserRating,
        current_track_starred: currentTrackStarred,
        servers: auth.servers.map(({ id, name }) => ({ id, name })),
        music_library: {
          active_server_id: sid,
          selected,
          folders: auth.musicFolders.map(f => ({ id: f.id, name: f.name })),
        },
      };
      const stableKey = JSON.stringify({
        trackId: s.currentTrack?.id ?? null,
        radioId: s.currentRadio?.id ?? null,
        queueIndex: s.queueIndex,
        queueLength: total,
        isPlaying: s.isPlaying,
        volume: Math.round(s.volume * 100),
        repeatMode: s.repeatMode,
        serverId: sid ?? null,
        selected,
        currentTrackUserRating,
        currentTrackStarred,
      });
      const now = Date.now();
      const heartbeatMs = s.isPlaying ? SNAPSHOT_PLAYING_HEARTBEAT_MS : SNAPSHOT_IDLE_HEARTBEAT_MS;
      const stableChanged = stableKey !== lastStableKey;
      const playingEdge = s.isPlaying !== lastPlaying;
      if (!stableChanged && !playingEdge && now - lastPublishAt < heartbeatMs) return;
      lastStableKey = stableKey;
      lastPlaying = s.isPlaying;
      lastPublishAt = now;
      invoke('cli_publish_player_snapshot', { snapshot }).catch(() => {});
    };
    publish();
    const schedule = () => {
      if (tid !== undefined) return;
      tid = setTimeout(() => {
        tid = undefined;
        publish();
      }, 200);
    };
    const unsubP = usePlayerStore.subscribe(schedule);
    const unsubA = useAuthStore.subscribe(schedule);
    return () => {
      unsubP();
      unsubA();
      if (tid !== undefined) clearTimeout(tid);
    };
  }, []);
}
