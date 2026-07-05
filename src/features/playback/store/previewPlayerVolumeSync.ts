/**
 * Side-effect wiring: keep the Rust preview sink volume aligned with the main
 * player slider while a track preview is active.
 */
import { audioPreviewSetVolume } from '@/lib/api/audio';
import { computePreviewVolume, usePreviewStore } from '@/features/playback/store/previewStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';

usePlayerStore.subscribe((state, prev) => {
  if (state.volume === prev.volume) return;
  if (!usePreviewStore.getState().previewingId) return;
  audioPreviewSetVolume({ volume: computePreviewVolume() }).catch(() => {});
});
