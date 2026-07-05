import { invoke } from '@tauri-apps/api/core';
import { mprisSetMetadata, mprisSetPlayback } from '@/lib/api/mpris';
import { resolvePlaybackCoverScope } from '@/cover/ref';
import { resolveTrackCoverRefFromLibrary } from '@/cover/resolveEntryLibrary';
import { coverArtUrlForMpris } from '@/cover/integrations/mpris';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { getPlaybackProgressSnapshot, subscribePlaybackProgress } from '@/features/playback/store/playbackProgress';

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
      const title = currentTrack.title;
      const artist = currentTrack.artist;
      const album = currentTrack.album;
      const durationSecs = currentTrack.duration;
      if (currentTrack.coverArt && currentTrack.albumId) {
        void resolveTrackCoverRefFromLibrary(
          {
            id: currentTrack.id,
            albumId: currentTrack.albumId,
            coverArt: currentTrack.coverArt,
            discNumber: (currentTrack as { discNumber?: number }).discNumber,
          },
          resolvePlaybackCoverScope(),
        ).then(ref => {
          if (!ref) return;
          coverArtUrlForMpris(ref)
            .then(coverUrl => mprisSetMetadata({
              title,
              artist,
              album,
              coverUrl: coverUrl || undefined,
              durationSecs,
            }))
            .catch(() => {});
        });
      } else {
        mprisSetMetadata({
          title,
          artist,
          album,
          coverUrl: undefined,
          durationSecs,
        }).catch(() => {});
      }
    }

    // Update metadata when a radio station starts (initial push — station name as title).
    // ICY StreamTitle updates are forwarded by the radio:metadata listener below.
    if (currentRadio && currentRadio.id !== prevRadioId) {
      prevRadioId = currentRadio.id;
      prevTrackId = null;
      mprisSetMetadata({
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
      mprisSetPlayback({
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
    mprisSetPlayback({
      playing: true,
      positionSecs: currentTime,
    }).catch(() => {});
  });

  return () => {
    unsubMpris();
    unsubMprisProgress();
  };
}
