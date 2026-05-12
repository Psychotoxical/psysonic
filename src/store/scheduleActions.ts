import type { PlayerState } from './playerStoreTypes';
import {
  clearScheduledPauseTimers,
  clearScheduledResumeTimers,
  schedulePauseTimer,
  scheduleResumeTimer,
} from './scheduleTimers';

type SetState = (
  partial: Partial<PlayerState> | ((state: PlayerState) => Partial<PlayerState>),
) => void;
type GetState = () => PlayerState;

/**
 * User-facing scheduled-pause / scheduled-resume actions. Each setter
 * clamps the delay to ≥ 500 ms, stores the absolute target + start
 * timestamps in the store (so countdown UI can render a progress arc),
 * and arms a single-shot timer in `scheduleTimers.ts`. The matching
 * `clearScheduled*` actions cancel the timer and blank the timestamps.
 */
export function createScheduleActions(set: SetState, get: GetState): Pick<
  PlayerState,
  'clearScheduledPause' | 'clearScheduledResume' | 'schedulePauseIn' | 'scheduleResumeIn'
> {
  return {
    clearScheduledPause: () => {
      clearScheduledPauseTimers();
      set({ scheduledPauseAtMs: null, scheduledPauseStartMs: null });
    },

    clearScheduledResume: () => {
      clearScheduledResumeTimers();
      set({ scheduledResumeAtMs: null, scheduledResumeStartMs: null });
    },

    schedulePauseIn: (seconds) => {
      const s = get();
      if (!s.isPlaying) return;
      const delayMs = Math.max(500, Math.round(Number(seconds) * 1000));
      const startedAt = Date.now();
      const at = startedAt + delayMs;
      set({ scheduledPauseAtMs: at, scheduledPauseStartMs: startedAt });
      schedulePauseTimer(delayMs, () => {
        set({ scheduledPauseAtMs: null, scheduledPauseStartMs: null });
        get().pause();
      });
    },

    scheduleResumeIn: (seconds) => {
      const s = get();
      if (s.isPlaying) return;
      if (!s.currentTrack && !s.currentRadio) return;
      const delayMs = Math.max(500, Math.round(Number(seconds) * 1000));
      const startedAt = Date.now();
      const at = startedAt + delayMs;
      set({ scheduledResumeAtMs: at, scheduledResumeStartMs: startedAt });
      scheduleResumeTimer(delayMs, () => {
        set({ scheduledResumeAtMs: null, scheduledResumeStartMs: null });
        get().resume();
      });
    },
  };
}
