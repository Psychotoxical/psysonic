import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type QueueToolbarButtonId =
  | 'shuffle'
  | 'playlist'
  | 'share'
  | 'clear'
  | 'separator'
  | 'gapless'
  | 'crossfade'
  | 'autodj'
  | 'infinite';

export interface QueueToolbarButtonConfig {
  id: QueueToolbarButtonId;
  visible: boolean;
}

/**
 * Default order and visibility for queue toolbar buttons. `playlist` is a
 * submenu hosting save + load; `crossfade` and `autodj` sit next to each other
 * as the two crossfade-style transition modes.
 */
export const DEFAULT_QUEUE_TOOLBAR_BUTTONS: QueueToolbarButtonConfig[] = [
  { id: 'shuffle',   visible: true },
  { id: 'playlist',  visible: true },
  { id: 'share',     visible: true },
  { id: 'clear',     visible: true },
  { id: 'separator', visible: true },
  { id: 'gapless',   visible: true },
  { id: 'crossfade', visible: true },
  { id: 'autodj',    visible: true },
  { id: 'infinite',  visible: true },
];

/** Pre-split ids that still live in persisted configs from older versions. */
type LegacyEntry = { id: QueueToolbarButtonId | 'save' | 'load'; visible: boolean };

/**
 * Bring a persisted button array up to the current id set, preserving the
 * user's order and visibility:
 *   1. drop corrupt entries,
 *   2. collapse legacy `save` + `load` into a single `playlist` button at the
 *      earlier of the two positions (visible if either was visible),
 *   3. drop anything not in the current id set,
 *   4. insert the new `autodj` button right after `crossfade`, and
 *   5. append any still-missing defaults.
 */
export function migrateQueueToolbarButtons(raw: unknown): QueueToolbarButtonConfig[] {
  const arr = Array.isArray(raw) ? raw : [];
  const cleaned = arr.filter(
    (b): b is LegacyEntry =>
      b != null && typeof b.id === 'string' && typeof (b as LegacyEntry).visible === 'boolean',
  );

  // Legacy save + load -> single playlist button.
  const legacySaveLoad = cleaned.filter(b => b.id === 'save' || b.id === 'load');
  const alreadyHasPlaylist = cleaned.some(b => b.id === 'playlist');
  let collapsed: LegacyEntry[] = cleaned;
  if (legacySaveLoad.length > 0 && !alreadyHasPlaylist) {
    const playlistVisible = legacySaveLoad.some(b => b.visible);
    let inserted = false;
    collapsed = [];
    for (const b of cleaned) {
      if (b.id === 'save' || b.id === 'load') {
        if (!inserted) { collapsed.push({ id: 'playlist', visible: playlistVisible }); inserted = true; }
        continue;
      }
      collapsed.push(b);
    }
  }

  // Keep only current ids (also drops any leftover save/load).
  const knownIds = new Set<QueueToolbarButtonId>(DEFAULT_QUEUE_TOOLBAR_BUTTONS.map(b => b.id));
  let safe = collapsed.filter(
    (b): b is QueueToolbarButtonConfig => knownIds.has(b.id as QueueToolbarButtonId),
  );

  // Insert the new autodj button next to an existing crossfade, inheriting its
  // visibility (the upgrade case). When crossfade isn't present yet (fresh or
  // corrupt input) we leave autodj to the default-fill step below so it lands
  // in its canonical position instead of at the front.
  const cfIdx = safe.findIndex(b => b.id === 'crossfade');
  if (cfIdx >= 0 && !safe.some(b => b.id === 'autodj')) {
    const autodj: QueueToolbarButtonConfig = { id: 'autodj', visible: safe[cfIdx].visible };
    safe = [...safe.slice(0, cfIdx + 1), autodj, ...safe.slice(cfIdx + 1)];
  }

  // Append any default still missing (fresh install, or pruned ids).
  const seen = new Set(safe.map(b => b.id));
  const missing = DEFAULT_QUEUE_TOOLBAR_BUTTONS.filter(b => !seen.has(b.id));
  return missing.length > 0 ? [...safe, ...missing] : safe;
}

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
        state.buttons = migrateQueueToolbarButtons(state.buttons);
      },
    }
  )
);
