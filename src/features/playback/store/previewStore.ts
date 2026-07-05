import { buildStreamUrl } from '@/lib/api/subsonicStreamUrl';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import type { TrackPreviewLocation } from '@/store/authStoreTypes';
import { create } from 'zustand';
import { audioPreviewPlay, audioPreviewStop } from '@/lib/api/audio';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useAuthStore } from '@/store/authStore';
import { isOrbitPlaybackSyncActive } from '@/store/orbitRuntime';

/** Minimal track info needed to surface the preview in the player bar UI. */
export interface PreviewingTrack {
  id: string;
  title: string;
  artist: string;
  coverArt?: string;
}

export interface PreviewSongInput {
  id: string;
  title: string;
  artist: string;
  coverArt?: string;
  duration?: number;
  suffix?: string;
}

/** Map a browse/playlist song row into preview input (keeps Subsonic suffix for format hints). */
export function previewInputFromSong(
  song: Pick<SubsonicSong, 'id' | 'title' | 'artist' | 'coverArt' | 'duration' | 'suffix'>,
): PreviewSongInput {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    coverArt: song.coverArt,
    duration: song.duration,
    suffix: song.suffix,
  };
}

interface PreviewState {
  /** Subsonic song id of the active preview, or null when nothing previews. */
  previewingId: string | null;
  /** Currently previewing track with the metadata the player-bar UI needs. */
  previewingTrack: PreviewingTrack | null;
  /** Seconds elapsed in the current preview window. */
  elapsed: number;
  /** Total preview window in seconds (echoes the duration_sec arg). */
  duration: number;
  /**
   * True only after the engine has emitted `audio:preview-start` for the
   * current `previewingId` — i.e. audio is actually playing. Drives the
   * progress-ring animation so the ring doesn't run ahead of the speaker
   * during the engine's download/decode/seek warmup. Reset to false on every
   * `startPreview` call so a switch from track A to track B doesn't carry
   * over A's animation state.
   */
  audioStarted: boolean;

  startPreview: (song: PreviewSongInput, location: TrackPreviewLocation) => Promise<void>;
  stopPreview: () => Promise<void>;

  /** Internal — called from the TauriEventBridge on `audio:preview-start`. */
  _onStart: (id: string) => void;
  /** Internal — called from the TauriEventBridge on `audio:preview-progress`. */
  _onProgress: (id: string, elapsed: number, duration: number) => void;
  /** Internal — called from the TauriEventBridge on `audio:preview-end`. */
  _onEnd: (id: string) => void;
}

const PREVIEW_VOLUME_MATCH = true;

/**
 * Effective preview volume to send to the Rust engine.
 *
 * Mirrors the main sink's audible level: takes the player's slider value and,
 * when loudness normalization is active, folds in the LUFS pre-analysis
 * attenuation the engine applies to the main sink (the engine has no view of
 * preview-specific gain, so we pre-multiply here). Master headroom is added on
 * the Rust side.
 */
export function computePreviewVolume(): number {
  const auth = useAuthStore.getState();
  let volume = usePlayerStore.getState().volume;
  if (PREVIEW_VOLUME_MATCH && auth.normalizationEngine === 'loudness') {
    const preDbAtt = Math.min(0, auth.loudnessPreAnalysisAttenuationDb ?? -4.5);
    volume = volume * Math.pow(10, preDbAtt / 20);
  }
  return Math.max(0, Math.min(1, volume));
}

export const usePreviewStore = create<PreviewState>((set, get) => ({
  previewingId: null,
  previewingTrack: null,
  elapsed: 0,
  duration: 30,
  audioStarted: false,

  startPreview: async (song, location) => {
    const auth = useAuthStore.getState();
    if (!auth.trackPreviewsEnabled) return;
    if (!auth.trackPreviewLocations[location]) return;

    // Block preview during any Orbit session — the preview path runs
    // through the same Rust audio engine as the shared playback, and a
    // preview started by a guest would yank the host's track out from
    // under them. UI buttons are hidden via `[data-orbit-active]` CSS;
    // this guards keyboard shortcuts / programmatic callers.
    if (isOrbitPlaybackSyncActive()) return;

    const current = get().previewingId;
    if (current === song.id) {
      await get().stopPreview();
      return;
    }

    const previewDuration = auth.trackPreviewDurationSec;
    const startRatio = auth.trackPreviewStartRatio;
    const url = buildStreamUrl(song.id);
    const trackDuration = Math.max(song.duration ?? 0, 0);
    const startSec = trackDuration > previewDuration * 1.5
      ? trackDuration * startRatio
      : 0;

    set({
      previewingId: song.id,
      previewingTrack: {
        id: song.id,
        title: song.title,
        artist: song.artist,
        coverArt: song.coverArt,
      },
      elapsed: 0,
      duration: previewDuration,
      audioStarted: false,
    });

    try {
      await audioPreviewPlay({
        id: song.id,
        url,
        startSec,
        durationSec: previewDuration,
        volume: computePreviewVolume(),
        formatSuffix: song.suffix ?? null,
      });
    } catch (e) {
      // Roll back optimistic state on failure.
      if (get().previewingId === song.id) {
        set({ previewingId: null, previewingTrack: null, elapsed: 0, audioStarted: false });
      }
      console.error('Preview playback failed', e);
    }
  },

  stopPreview: async () => {
    if (!get().previewingId) return;
    try {
      await audioPreviewStop();
    } catch {
      /* engine will emit preview-end anyway; clear locally as fallback */
      set({ previewingId: null, previewingTrack: null, elapsed: 0, audioStarted: false });
    }
  },

  _onStart: (id) => {
    const current = get().previewingId;
    if (current !== id) {
      // Engine fired start for an id we didn't track locally — keep id but
      // leave previewingTrack as-is (the caller's startPreview() set it).
      set({ previewingId: id, elapsed: 0, audioStarted: true });
    } else {
      // Audio is now actually playing — unblock the progress-ring animation.
      set({ audioStarted: true });
    }
  },

  _onProgress: (id, elapsed, duration) => {
    if (get().previewingId !== id) return;
    set({ elapsed, duration });
  },

  _onEnd: (id) => {
    if (get().previewingId !== id) return;
    set({ previewingId: null, previewingTrack: null, elapsed: 0, audioStarted: false });
  },
}));
