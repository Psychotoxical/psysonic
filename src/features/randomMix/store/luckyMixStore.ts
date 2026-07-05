import { create } from 'zustand';

interface LuckyMixState {
  /** True while `buildAndPlayLuckyMix` is actively assembling a mix. */
  isRolling: boolean;
  /**
   * Set by `cancel()` — the build loop polls this between awaits and bails
   * out silently when true. Reset to false on `start()` so a new build can
   * run after a cancelled one.
   */
  cancelRequested: boolean;
  start: () => void;
  stop: () => void;
  cancel: () => void;
}

export const useLuckyMixStore = create<LuckyMixState>((set) => ({
  isRolling: false,
  cancelRequested: false,
  start:  () => set({ isRolling: true, cancelRequested: false }),
  stop:   () => set({ isRolling: false, cancelRequested: false }),
  cancel: () => set({ cancelRequested: true }),
}));
