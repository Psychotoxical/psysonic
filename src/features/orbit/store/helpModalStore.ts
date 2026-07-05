import { create } from 'zustand';

interface HelpModalStore {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

/**
 * App-wide toggle for the Orbit help modal. Two triggers — the launch
 * popover "How does this work?" entry and the in-session bar help button
 * — write to the same store so they share the one rendered modal. Not
 * persisted; resets to closed on reload.
 */
export const useHelpModalStore = create<HelpModalStore>(set => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
