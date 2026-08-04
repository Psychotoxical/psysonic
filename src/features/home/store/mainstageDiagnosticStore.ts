import { create } from 'zustand';
import type { HomeSectionId } from '@/features/home/store/homeStore';

export const MAINSTAGE_DIAGNOSTIC_SECTION_IDS = [
  'hero',
  'recent',
  'becauseYouLike',
  'discover',
  'discoverSongs',
  'discoverArtists',
  'recentlyPlayed',
  'starred',
  'mostPlayed',
  'losslessAlbums',
] as const satisfies readonly HomeSectionId[];

export type MainstageDiagnosticStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'error'
  | 'timeout'
  | 'disabled';

export interface MainstageDiagnosticSectionState {
  enabled: boolean;
  status: MainstageDiagnosticStatus;
  durationMs: number | null;
  itemCount: number | null;
  detail?: string;
}

export interface MainstageDiagnosticFinish {
  status: Extract<MainstageDiagnosticStatus, 'ready' | 'empty' | 'error' | 'timeout'>;
  durationMs?: number | null;
  itemCount?: number | null;
  detail?: string;
}

interface MainstageDiagnosticStore {
  sections: Record<HomeSectionId, MainstageDiagnosticSectionState>;
  toggle: (id: HomeSectionId) => void;
  setEnabled: (id: HomeSectionId, enabled: boolean) => void;
  start: (id: HomeSectionId, detail?: string) => void;
  finish: (id: HomeSectionId, result: MainstageDiagnosticFinish) => void;
  reset: () => void;
}

function createSectionState(): MainstageDiagnosticSectionState {
  return {
    enabled: true,
    status: 'idle',
    durationMs: null,
    itemCount: null,
  };
}

export function createMainstageDiagnosticSections(): Record<HomeSectionId, MainstageDiagnosticSectionState> {
  return Object.fromEntries(
    MAINSTAGE_DIAGNOSTIC_SECTION_IDS.map(id => [id, createSectionState()]),
  ) as Record<HomeSectionId, MainstageDiagnosticSectionState>;
}

export function snapshotMainstageDiagnosticSections(): Record<HomeSectionId, MainstageDiagnosticSectionState> {
  return structuredClone(useMainstageDiagnosticStore.getState().sections);
}

export function restoreMainstageDiagnosticSections(
  sections: Record<HomeSectionId, MainstageDiagnosticSectionState>,
): void {
  useMainstageDiagnosticStore.setState({ sections: structuredClone(sections) });
}

export const useMainstageDiagnosticStore = create<MainstageDiagnosticStore>((set) => ({
  sections: createMainstageDiagnosticSections(),

  toggle: (id) => set((state) => {
    const enabled = !state.sections[id].enabled;
    return {
      sections: {
        ...state.sections,
        [id]: enabled ? createSectionState() : { ...createSectionState(), enabled: false, status: 'disabled' },
      },
    };
  }),

  setEnabled: (id, enabled) => set((state) => {
    if (state.sections[id].enabled === enabled) return state;
    return {
      sections: {
        ...state.sections,
        [id]: enabled ? createSectionState() : { ...createSectionState(), enabled: false, status: 'disabled' },
      },
    };
  }),

  start: (id, detail) => set((state) => {
    if (!state.sections[id].enabled) return state;
    return {
      sections: {
        ...state.sections,
        [id]: {
          enabled: true,
          status: 'loading',
          durationMs: null,
          itemCount: null,
          ...(detail !== undefined ? { detail } : {}),
        },
      },
    };
  }),

  finish: (id, result) => set((state) => {
    if (!state.sections[id].enabled) return state;
    return {
      sections: {
        ...state.sections,
        [id]: {
          enabled: true,
          status: result.status,
          durationMs: result.durationMs ?? null,
          itemCount: result.itemCount ?? null,
          ...(result.detail !== undefined ? { detail: result.detail } : {}),
        },
      },
    };
  }),

  reset: () => set({ sections: createMainstageDiagnosticSections() }),
}));
