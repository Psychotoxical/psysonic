import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type NpColumn = 'left' | 'right';

export type NpCardId =
  | 'album'
  | 'topSongs'
  | 'credits'
  | 'artist'
  | 'discography'
  | 'tour';

export interface NpCardConfig {
  id: NpCardId;
  column: NpColumn;
  visible: boolean;
}

export const NP_CARD_IDS: NpCardId[] = ['album', 'topSongs', 'credits', 'artist', 'discography', 'tour'];

export const DEFAULT_NP_LAYOUT: NpCardConfig[] = [
  { id: 'album',       column: 'left',  visible: true },
  { id: 'topSongs',    column: 'left',  visible: true },
  { id: 'credits',     column: 'left',  visible: true },
  { id: 'artist',      column: 'right', visible: true },
  { id: 'discography', column: 'right', visible: true },
  { id: 'tour',        column: 'right', visible: true },
];

interface NpLayoutStore {
  cards: NpCardConfig[];
  /** Move a card to a column at a given insertion index (0-based within that column). */
  moveCard: (id: NpCardId, toColumn: NpColumn, toIndex: number) => void;
  setVisible: (id: NpCardId, visible: boolean) => void;
  reset: () => void;
}

export const useNpLayoutStore = create<NpLayoutStore>()(
  persist(
    (set) => ({
      cards: DEFAULT_NP_LAYOUT,

      moveCard: (id, toColumn, toIndex) => set((s) => {
        const target = s.cards.find(c => c.id === id);
        if (!target) return s;
        const without = s.cards.filter(c => c.id !== id);
        const left  = without.filter(c => c.column === 'left');
        const right = without.filter(c => c.column === 'right');
        const moved: NpCardConfig = { ...target, column: toColumn };
        const targetBucket = toColumn === 'left' ? left : right;
        const clamped = Math.max(0, Math.min(toIndex, targetBucket.length));
        targetBucket.splice(clamped, 0, moved);
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
