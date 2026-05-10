import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type QueueToolbarButtonId =
  | 'shuffle'
  | 'save'
  | 'load'
  | 'share'
  | 'clear'
  | 'separator'
  | 'gapless'
  | 'crossfade'
  | 'infinite';

export interface QueueToolbarButtonConfig {
  id: QueueToolbarButtonId;
  visible: boolean;
}

/**
 * Default order and visibility for queue toolbar buttons.
 * Matches the historical layout in QueuePanel.tsx.
 */
export const DEFAULT_QUEUE_TOOLBAR_BUTTONS: QueueToolbarButtonConfig[] = [
  { id: 'shuffle',   visible: true },
  { id: 'save',      visible: true },
  { id: 'load',      visible: true },
  { id: 'share',     visible: true },
  { id: 'clear',     visible: true },
  { id: 'separator', visible: true },
  { id: 'gapless',   visible: true },
  { id: 'crossfade', visible: true },
  { id: 'infinite',  visible: true },
];

interface QueueToolbarStore {
  buttons: QueueToolbarButtonConfig[];
  setButtons: (buttons: QueueToolbarButtonConfig[]) => void;
  toggleButton: (id: QueueToolbarButtonId) => void;
  reset: () => void;
}

export const useQueueToolbarStore = create<QueueToolbarStore>()(
  persist(
    (set) => ({
      buttons: DEFAULT_QUEUE_TOOLBAR_BUTTONS,

      setButtons: (buttons) => set({ buttons }),

      toggleButton: (id) => set((s) => ({
        buttons: s.buttons.map(btn => btn.id === id ? { ...btn, visible: !btn.visible } : btn),
      })),

      reset: () => set({ buttons: DEFAULT_QUEUE_TOOLBAR_BUTTONS }),
    }),
    {
      name: 'psysonic_queue_toolbar',
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Sanitize: remove null/corrupt entries
        const knownIds = new Set(DEFAULT_QUEUE_TOOLBAR_BUTTONS.map(b => b.id));
        const safe = (state.buttons ?? [])
          .filter((b): b is QueueToolbarButtonConfig => b != null && typeof b.id === 'string' && knownIds.has(b.id as QueueToolbarButtonId));
        const seen = new Set(safe.map(b => b.id));
        const missing = DEFAULT_QUEUE_TOOLBAR_BUTTONS.filter(b => !seen.has(b.id));
        state.buttons = missing.length > 0 ? [...safe, ...missing] : safe;
      },
    }
  )
);
