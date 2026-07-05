import { librarySetPlaybackHint, type PlaybackHint } from '@/lib/api/library';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';

/**
 * Bridge from the audio lifecycle to the Rust library scheduler's
 * bandwidth lane (spec §6.2.4, PR-5 kickoff Q3 — JS pushes the hint).
 * Only fires when the local index is enabled for the active server,
 * and dedupes repeated identical hints so we don't spam the IPC
 * boundary on every progress tick.
 */
let lastHint: PlaybackHint | null = null;

export function notifyLibraryPlaybackHint(hint: PlaybackHint): void {
  const activeId = useAuthStore.getState().activeServerId;
  if (!useLibraryIndexStore.getState().isIndexEnabled(activeId)) {
    lastHint = null;
    return;
  }
  if (lastHint === hint) return;
  lastHint = hint;
  void librarySetPlaybackHint(hint).catch(() => {
    /* best-effort — scheduler falls back to Idle parallelism */
  });
}
