import { invoke } from '@tauri-apps/api/core';
import { isRecoverableSeekError } from '../utils/seekErrors';
import { useAuthStore } from './authStore';
import { shouldRebindPlaybackToHotCache } from './playbackUrlRouting';
import type { PlayerState } from './playerStoreTypes';
import { armSeekDebounce } from './seekDebounce';
import {
  clearSeekFallbackRetry,
  getSeekFallbackRestartAt,
  getSeekFallbackTrackId,
  scheduleSeekFallbackRetry,
  setSeekFallbackRestartAt,
  setSeekFallbackTrackId,
  setSeekFallbackVisualTarget,
} from './seekFallbackState';
import {
  clearSeekTarget,
  setSeekTarget,
} from './seekTargetState';

type SetState = (
  partial: Partial<PlayerState> | ((state: PlayerState) => Partial<PlayerState>),
) => void;
type GetState = () => PlayerState;

/**
 * Seek to a 0..1 fraction of the current track. 100 ms debounce
 * collapses rapid slider drags into one actual engine seek; when the
 * resolved playback source is about to be replaced by a hot-cache
 * rebind, we re-issue `playTrack` with a visual target instead of
 * a raw `audio_seek` (otherwise the seek would land in the old
 * source and snap the progress UI back).
 *
 * Recoverable backend errors (streaming start not yet seekable / busy)
 * are translated into a bounded retry burst: keep the UI's visual
 * target pinned at the requested position, schedule another seek
 * attempt, and on the "not seekable" subset restart the track from
 * the same position via `playTrack`.
 */
export function runSeek(set: SetState, get: GetState, progress: number): void {
  const { currentTrack } = get();
  if (!currentTrack) return;
  const dur = currentTrack.duration;
  if (!dur || !isFinite(dur)) return;
  const time = Math.max(0, Math.min(progress * dur, dur - 0.25));
  set({ progress: time / dur, currentTime: time });
  armSeekDebounce(100, () => {
    const s0 = get();
    if (!s0.currentTrack) return;
    const authSeek = useAuthStore.getState();
    const sidSeek = authSeek.activeServerId ?? '';
    if (shouldRebindPlaybackToHotCache(s0.currentTrack.id, sidSeek)) {
      setSeekFallbackVisualTarget({
        trackId: s0.currentTrack.id,
        seconds: time,
        setAtMs: Date.now(),
      });
      clearSeekFallbackRetry();
      s0.playTrack(s0.currentTrack, s0.queue, true);
      return;
    }
    invoke('audio_seek', { seconds: time }).then(() => {
      // Arm stale-progress guard only after backend acknowledged seek.
      setSeekTarget(time);
      setSeekFallbackVisualTarget(null);
      clearSeekFallbackRetry();
    }).catch((err: unknown) => {
      // Release the progress-tick guard so the UI doesn't freeze
      // waiting for a target the engine will never reach.
      clearSeekTarget();
      const msg = String(err ?? '');
      if (!isRecoverableSeekError(msg)) {
        console.error(err);
        setSeekFallbackVisualTarget(null);
        clearSeekFallbackRetry();
        return;
      }
      // Streaming-start path can be temporarily non-seekable or busy.
      // Keep UI at target and retry seek for a short bounded window.
      const s = get();
      if (!s.currentTrack) return;
      const now = Date.now();
      const sameBurst =
        getSeekFallbackTrackId() === s.currentTrack.id
        && now - getSeekFallbackRestartAt() < 600;
      setSeekFallbackVisualTarget({
        trackId: s.currentTrack.id,
        seconds: time,
        setAtMs: Date.now(),
      });
      // Keep stale progress ticks from snapping UI back to start while
      // recoverable seek retries are still in flight.
      setSeekTarget(time);
      if (msg.includes('not seekable') && !sameBurst) {
        setSeekFallbackTrackId(s.currentTrack.id);
        setSeekFallbackRestartAt(now);
        // Keep manual semantics (no crossfade) for seek recovery restarts.
        s.playTrack(s.currentTrack, s.queue, true);
      }
      scheduleSeekFallbackRetry(s.currentTrack.id, time);
    });
  });
}
