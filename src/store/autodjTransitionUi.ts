import { create } from 'zustand';

/** User-visible AutoDJ transition feedback on the player-bar play button. */
export type AutodjTransitionPhase = 'idle' | 'preparing' | 'mixing';

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
 * B is not ready yet or the JS early-advance is armed — slower pulse on the
 * play button. Mixing takes priority when both are active.
 */
export function setAutodjPreparing(active: boolean): void {
  const { phase } = useAutodjTransitionUi.getState();
  if (active) {
    if (phase === 'mixing') return;
    useAutodjTransitionUi.setState({ phase: 'preparing' });
    return;
  }
  if (phase === 'preparing') {
    useAutodjTransitionUi.setState({ phase: 'idle' });
  }
}

/** Active crossfade overlap — faster pulse until `overlapSec` elapses. */
export function armAutodjMixing(overlapSec: number): void {
  if (!(overlapSec > 0)) return;
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
