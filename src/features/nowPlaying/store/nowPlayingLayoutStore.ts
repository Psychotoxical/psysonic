import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type NpColumn = 'left' | 'right';

export type NpCardId =
  | 'album'
  | 'topSongs'
  | 'credits'
  | 'artist'
  | 'discography'
  | 'tour'
  | 'visualizer';

export interface NpCardConfig {
  id: NpCardId;
  column: NpColumn;
  visible: boolean;
}

export const NP_CARD_IDS: NpCardId[] = ['album', 'topSongs', 'credits', 'artist', 'discography', 'tour', 'visualizer'];

export const DEFAULT_NP_LAYOUT: NpCardConfig[] = [
  { id: 'visualizer',  column: 'left',  visible: true },
  { id: 'album',       column: 'left',  visible: true },
  { id: 'topSongs',    column: 'left',  visible: true },
  { id: 'credits',     column: 'left',  visible: true },
  { id: 'artist',      column: 'right', visible: true },
  { id: 'discography', column: 'right', visible: true },
  { id: 'tour',        column: 'right', visible: true },
];

/** Runtime feature filtering keeps optional cards out of the layout UI without
 * deleting their persisted position/visibility preference. */
export function availableNpCards(
  cards: NpCardConfig[],
  options: { visualizerEnabled: boolean },
): NpCardConfig[] {
  return options.visualizerEnabled ? cards : cards.filter(card => card.id !== 'visualizer');
}

interface NpLayoutStore {
  cards: NpCardConfig[];
  /** Move a card to a visible insertion index while preserving hidden-card placement. */
  moveCard: (
    id: NpCardId,
    toColumn: NpColumn,
    toIndex: number,
    visibleCardIds: readonly NpCardId[],
  ) => void;
  setVisible: (id: NpCardId, visible: boolean) => void;
  reset: () => void;
}

export const useNpLayoutStore = create<NpLayoutStore>()(
  persist(
    (set) => ({
      cards: DEFAULT_NP_LAYOUT,

      moveCard: (id, toColumn, toIndex, visibleCardIds) => set((s) => {
        const target = s.cards.find(c => c.id === id);
        if (!target) return s;
        const without = s.cards.filter(c => c.id !== id);
        const left  = without.filter(c => c.column === 'left');
        const right = without.filter(c => c.column === 'right');
        const moved: NpCardConfig = { ...target, column: toColumn };
        const targetBucket = toColumn === 'left' ? left : right;
        const visibleIdSet = new Set(visibleCardIds);
        const visibleTargetBucket = targetBucket.filter(card => visibleIdSet.has(card.id));
        const clamped = Math.max(0, Math.min(toIndex, visibleTargetBucket.length));
        const nextVisible = visibleTargetBucket[clamped];
        let insertionIndex = targetBucket.length;
        if (nextVisible) {
          insertionIndex = targetBucket.findIndex(card => card.id === nextVisible.id);
        } else {
          const lastVisible = visibleTargetBucket[visibleTargetBucket.length - 1];
          if (lastVisible) {
            insertionIndex = targetBucket.findIndex(card => card.id === lastVisible.id) + 1;
          }
        }
        targetBucket.splice(insertionIndex, 0, moved);
        return { cards: [...left, ...right] };
      }),

      setVisible: (id, visible) => set((s) => ({
        cards: s.cards.map(c => c.id === id ? { ...c, visible } : c),
      })),

      reset: () => set({ cards: DEFAULT_NP_LAYOUT }),
    }),
    {
      name: 'psysonic_np_layout',
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const safe = (state.cards ?? []).filter((c): c is NpCardConfig =>
          c != null && typeof c.id === 'string' && NP_CARD_IDS.includes(c.id as NpCardId)
        );
        const known = new Set(safe.map(c => c.id));
        const missing = DEFAULT_NP_LAYOUT.filter(c => !known.has(c.id));
        state.cards = missing.length > 0 ? [...safe, ...missing] : safe;
      },
    },
  ),
);
