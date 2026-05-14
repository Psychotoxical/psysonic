import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getPlaybackProgressSnapshot } from '../../store/playbackProgress';
import { usePlayerStore } from '../../store/playerStore';
import { useAuthStore } from '../../store/authStore';

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
      const snapshot = {
        current_track: s.currentTrack,
        current_radio: s.currentRadio,
        queue: s.queue,
        queue_index: s.queueIndex,
        queue_length: s.queue.length,
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
        queueLength: s.queue.length,
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
