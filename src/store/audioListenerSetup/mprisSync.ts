import { invoke } from '@tauri-apps/api/core';
import { buildCoverArtUrl } from '../../api/subsonicStreamUrl';
import { usePlayerStore } from '../playerStore';
import { getPlaybackProgressSnapshot, subscribePlaybackProgress } from '../playbackProgress';

/**
 * MPRIS / OS media-controls sync. Whenever the current track or playback state
 * changes, pushes updates to the Rust souvlaki MediaControls so the OS media
 * overlay stays accurate. Returns a cleanup function.
 */
export function setupMprisSync(): () => void {
  let prevTrackId: string | null = null;
  let prevRadioId: string | null = null;
  let prevIsPlaying: boolean | null = null;
  let lastMprisPositionUpdate = 0;

  const unsubMpris = usePlayerStore.subscribe((state) => {
    const { currentTrack, currentRadio, isPlaying } = state;

    // Update metadata when track changes
    if (currentTrack && currentTrack.id !== prevTrackId) {
      prevTrackId = currentTrack.id;
      prevRadioId = null;
      const coverUrl = currentTrack.coverArt
        ? buildCoverArtUrl(currentTrack.coverArt, 512)
        : undefined;
      invoke('mpris_set_metadata', {
        title: currentTrack.title,
        artist: currentTrack.artist,
        album: currentTrack.album,
        coverUrl,
        durationSecs: currentTrack.duration,
      }).catch(() => {});
    }

    // Update metadata when a radio station starts (initial push — station name as title).
    // ICY StreamTitle updates are forwarded by the radio:metadata listener below.
    if (currentRadio && currentRadio.id !== prevRadioId) {
      prevRadioId = currentRadio.id;
      prevTrackId = null;
      invoke('mpris_set_metadata', {
        title: currentRadio.name,
        artist: null,
        album: null,
        coverUrl: null,
        durationSecs: null,
      }).catch(() => {});
    }

    // Update playback state on play/pause change (use live snapshot — persisted
    // store currentTime is intentionally coarse between commits).
    const playbackChanged = isPlaying !== prevIsPlaying;
    if (playbackChanged) {
      prevIsPlaying = isPlaying;
      lastMprisPositionUpdate = Date.now();
      const pos = getPlaybackProgressSnapshot().currentTime;
      invoke('mpris_set_playback', {
        playing: isPlaying,
        positionSecs: pos > 0 ? pos : null,
      }).catch(() => {});
      invoke('update_taskbar_icon', { isPlaying }).catch(() => {});
      return;
    }
  });
  const unsubMprisProgress = subscribePlaybackProgress(({ currentTime }) => {
    const { currentRadio, isPlaying } = usePlayerStore.getState();
    if (currentRadio || !isPlaying) return;
    if (Date.now() - lastMprisPositionUpdate < 1500) return;
    lastMprisPositionUpdate = Date.now();
    invoke('mpris_set_playback', {
      playing: true,
      positionSecs: currentTime,
    }).catch(() => {});
  });

  return () => {
    unsubMpris();
    unsubMprisProgress();
  };
}
