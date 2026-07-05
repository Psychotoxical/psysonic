import { create } from 'zustand';
import { useAuthStore } from '@/store/authStore';
import { getTransitionMode } from '@/features/playback/utils/playback/playbackTransition';

/** User-visible AutoDJ transition feedback on the player-bar play button. */
export type AutodjTransitionPhase = 'idle' | 'mixing';

interface AutodjTransitionUiState {
  phase: AutodjTransitionPhase;
}

let mixingTimer: ReturnType<typeof setTimeout> | null = null;

export const useAutodjTransitionUi = create<AutodjTransitionUiState>(() => ({
  phase: 'idle',
}));

function clearMixingTimer(): void {
  if (mixingTimer) {
    clearTimeout(mixingTimer);
    mixingTimer = null;
  }
}

/** Drop any transition indicator (stop, hard cut, new idle track). */
export function clearAutodjTransitionUi(): void {
  clearMixingTimer();
  useAutodjTransitionUi.setState({ phase: 'idle' });
}

/**
 * Show the mixing indicator only while a real crossfade overlap is in progress.
 * No-op outside AutoDJ mode.
 */
export function armAutodjMixing(overlapSec: number): void {
  if (!(overlapSec > 0)) return;
  if (getTransitionMode(useAuthStore.getState()) !== 'autodj') return;
  clearMixingTimer();
  useAutodjTransitionUi.setState({ phase: 'mixing' });
  const ms = Math.round(overlapSec * 1000) + 250;
  mixingTimer = setTimeout(() => {
    mixingTimer = null;
    if (useAutodjTransitionUi.getState().phase === 'mixing') {
      useAutodjTransitionUi.setState({ phase: 'idle' });
    }
  }, ms);
}
