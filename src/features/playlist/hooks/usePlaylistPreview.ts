import { useCallback, useEffect } from 'react';
import { previewInputFromSong, usePreviewStore } from '@/features/playback/store/previewStore';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';

export function usePlaylistPreview(): {
  startPreview: (song: SubsonicSong) => void;
} {
  // Pause/resume of the main player + timer + cancel-on-supersede are all
  // handled in `audio_preview_play` / `audio_preview_stop`. The store mirrors
  // engine events so we just dispatch here and read `previewingId` for UI.
  const startPreview = useCallback((song: SubsonicSong) => {
    usePreviewStore.getState().startPreview(previewInputFromSong(song), 'suggestions').catch(() => { /* engine errored — store already rolled back */ });
  }, []);

  // Cancel any in-flight preview when the user navigates away.
  useEffect(() => () => {
    if (usePreviewStore.getState().previewingId) {
      usePreviewStore.getState().stopPreview();
    }
  }, []);

  return { startPreview };
}
