import { create } from 'zustand';
import type { GenreTagsInspectDto, ScopeBrowseProjectionInspectDto } from '@/lib/api/library';
import type { MigrationInspectReport, MigrationProgressEvent } from '@/lib/api/migration';

export type MigrationPhase = 'idle' | 'inspecting' | 'running' | 'completed' | 'error';
export type MigrationStep = 'serverIndex' | 'genreTags' | 'scopeBrowseProjection' | 'canonicalIds';

export interface GenreTagsProgressEvent {
  done: number;
  total: number;
}

interface MigrationState {
  phase: MigrationPhase;
  step: MigrationStep | null;
  needsMigration: boolean;
  inspect: MigrationInspectReport | null;
  progress: MigrationProgressEvent | null;
  genreTagsInspect: GenreTagsInspectDto | null;
  genreTagsProgress: GenreTagsProgressEvent | null;
  scopeBrowseProjectionInspect: ScopeBrowseProjectionInspectDto | null;
  scopeBrowseProjectionProgress: GenreTagsProgressEvent | null;
  lastError: string | null;
  blockingRevision: number;
  setPhase: (phase: MigrationPhase) => void;
  setStep: (step: MigrationStep | null) => void;
  setNeedsMigration: (needsMigration: boolean) => void;
  setInspect: (report: MigrationInspectReport | null) => void;
  setProgress: (event: MigrationProgressEvent | null) => void;
  setGenreTagsInspect: (report: GenreTagsInspectDto | null) => void;
  setGenreTagsProgress: (event: GenreTagsProgressEvent | null) => void;
  setScopeBrowseProjectionInspect: (report: ScopeBrowseProjectionInspectDto | null) => void;
  setScopeBrowseProjectionProgress: (event: GenreTagsProgressEvent | null) => void;
  setError: (error: string | null) => void;
}

export const useMigrationStore = create<MigrationState>(set => ({
  phase: 'idle',
  step: null,
  needsMigration: false,
  inspect: null,
  progress: null,
  genreTagsInspect: null,
  genreTagsProgress: null,
  scopeBrowseProjectionInspect: null,
  scopeBrowseProjectionProgress: null,
  lastError: null,
  blockingRevision: 0,
  setPhase: phase => set({ phase }),
  setStep: step => set({ step }),
  setNeedsMigration: needsMigration => set({ needsMigration }),
  setInspect: inspect => set({ inspect }),
  setProgress: progress => set({ progress }),
  setGenreTagsInspect: genreTagsInspect => set({ genreTagsInspect }),
  setGenreTagsProgress: genreTagsProgress => set({ genreTagsProgress }),
  setScopeBrowseProjectionInspect: scopeBrowseProjectionInspect => set({ scopeBrowseProjectionInspect }),
  setScopeBrowseProjectionProgress: scopeBrowseProjectionProgress => set({ scopeBrowseProjectionProgress }),
  setError: lastError => set({ lastError }),
}));
