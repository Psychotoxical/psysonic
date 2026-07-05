import { scheduleDeadlineMs, scheduleDelayMsFromSeconds } from '@/features/playback/utils/playback/playbackScheduleDelay';
import type { PlayerState } from '@/features/playback/store/playerStoreTypes';
import {
  clearScheduledPauseTimers,
  clearScheduledResumeTimers,
  schedulePauseTimer,
  scheduleResumeTimer,
} from '@/features/playback/store/scheduleTimers';

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
      const delayMs = scheduleDelayMsFromSeconds(seconds);
      const startedAt = Date.now();
      const at = scheduleDeadlineMs(startedAt, seconds);
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
      const delayMs = scheduleDelayMsFromSeconds(seconds);
      const startedAt = Date.now();
      const at = scheduleDeadlineMs(startedAt, seconds);
      set({ scheduledResumeAtMs: at, scheduledResumeStartMs: startedAt });
      scheduleResumeTimer(delayMs, () => {
        set({ scheduledResumeAtMs: null, scheduledResumeStartMs: null });
        get().resume();
      });
    },
  };
}
