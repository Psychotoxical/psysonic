import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { buildStreamUrl } from '../api/subsonic';
import { usePlayerStore } from './playerStore';
import { useAuthStore } from './authStore';

interface PreviewState {
  /** Subsonic song id of the active preview, or null when nothing previews. */
  previewingId: string | null;
  /** Seconds elapsed in the current preview window. */
  elapsed: number;
  /** Total preview window in seconds (echoes the duration_sec arg). */
  duration: number;

  startPreview: (song: { id: string; duration?: number }) => Promise<void>;
  stopPreview: () => Promise<void>;

  /** Internal — called from the TauriEventBridge on `audio:preview-start`. */
  _onStart: (id: string) => void;
  /** Internal — called from the TauriEventBridge on `audio:preview-progress`. */
  _onProgress: (id: string, elapsed: number, duration: number) => void;
  /** Internal — called from the TauriEventBridge on `audio:preview-end`. */
  _onEnd: (id: string) => void;
}

const PREVIEW_DURATION_SECS = 30;
const PREVIEW_START_RATIO = 0.33;
const PREVIEW_VOLUME_MATCH = true;

export const usePreviewStore = create<PreviewState>((set, get) => ({
  previewingId: null,
  elapsed: 0,
  duration: PREVIEW_DURATION_SECS,

  startPreview: async (song) => {
    const current = get().previewingId;
    if (current === song.id) {
      await get().stopPreview();
      return;
    }

    const url = buildStreamUrl(song.id);
    const trackDuration = Math.max(song.duration ?? 0, 0);
    const startSec = trackDuration > PREVIEW_DURATION_SECS * 1.5
      ? trackDuration * PREVIEW_START_RATIO
      : 0;

    // Match the main player's effective volume so preview doesn't blast at
    // unattenuated level. LUFS pre-analysis attenuation is folded into base
    // volume by the audio engine for the main sink; we mirror by reading the
    // player volume + applying the same headroom multiplier conceptually.
    let volume = usePlayerStore.getState().volume;
    if (PREVIEW_VOLUME_MATCH) {
      const auth = useAuthStore.getState();
      if (auth.normalizationEngine === 'loudness') {
        const preDbAtt = Math.min(0, auth.loudnessPreAnalysisAttenuationDb ?? -4.5);
        volume = volume * Math.pow(10, preDbAtt / 20);
      }
    }

    set({ previewingId: song.id, elapsed: 0, duration: PREVIEW_DURATION_SECS });

    try {
      await invoke('audio_preview_play', {
        id: song.id,
        url,
        startSec,
        durationSec: PREVIEW_DURATION_SECS,
        volume: Math.max(0, Math.min(1, volume)),
      });
    } catch (e) {
      // Roll back optimistic state on failure.
      if (get().previewingId === song.id) {
        set({ previewingId: null, elapsed: 0 });
      }
      throw e;
    }
  },

  stopPreview: async () => {
    if (!get().previewingId) return;
    try {
      await invoke('audio_preview_stop');
    } catch {
      /* engine will emit preview-end anyway; clear locally as fallback */
      set({ previewingId: null, elapsed: 0 });
    }
  },

  _onStart: (id) => {
    if (get().previewingId !== id) {
      set({ previewingId: id, elapsed: 0 });
    }
  },

  _onProgress: (id, elapsed, duration) => {
    if (get().previewingId !== id) return;
    set({ elapsed, duration });
  },

  _onEnd: (id) => {
    if (get().previewingId !== id) return;
    set({ previewingId: null, elapsed: 0 });
  },
}));
