import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../store/authStore';
import { useMigrationStore } from '../store/migrationStore';

const migrationInspectMock = vi.fn();
const migrationRunMock = vi.fn();
const libraryGenreTagsInspectMock = vi.fn();
const libraryGenreTagsRunMock = vi.fn();
const rewriteFrontendStoreKeysMock = vi.fn(async (_servers: unknown) => undefined);

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('../api/migration', () => ({
  migrationInspect: (mappings: unknown) => migrationInspectMock(mappings),
  migrationRun: (mappings: unknown) => migrationRunMock(mappings),
}));

vi.mock('../api/library', () => ({
  libraryGenreTagsInspect: () => libraryGenreTagsInspectMock(),
  libraryGenreTagsRun: () => libraryGenreTagsRunMock(),
}));

vi.mock('../utils/server/rewriteFrontendStoreKeys', () => ({
  rewriteFrontendStoreKeys: (servers: unknown) => rewriteFrontendStoreKeysMock(servers),
}));

import { useMigrationOrchestrator } from './useMigrationOrchestrator';

const DONE_FLAG = 'psysonic-server-key-migration-v1';
const REAL_MIGRATION_TEST_OVERRIDE = '__PSYSONIC_REAL_MIGRATION_TEST__';

describe('useMigrationOrchestrator', () => {
  beforeEach(() => {
    migrationInspectMock.mockReset();
    migrationRunMock.mockReset();
    libraryGenreTagsInspectMock.mockReset();
    libraryGenreTagsRunMock.mockReset();
    libraryGenreTagsInspectMock.mockResolvedValue({ needed: false, totalTracks: 0, doneTracks: 0 });
    libraryGenreTagsRunMock.mockResolvedValue(undefined);
    rewriteFrontendStoreKeysMock.mockClear();
    localStorage.clear();
    useAuthStore.setState({
      servers: [
        { id: 'legacy-a', name: 'A', url: 'https://a.test', username: 'u', password: 'p' },
      ],
      activeServerId: 'legacy-a',
      isLoggedIn: true,
    });
    useMigrationStore.setState({
      phase: 'inspecting',
      step: null,
      needsMigration: false,
      inspect: null,
      progress: null,
      genreTagsInspect: null,
      genreTagsProgress: null,
      lastError: null,
    });
    (globalThis as Record<string, unknown>)[REAL_MIGRATION_TEST_OVERRIDE] = true;
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[REAL_MIGRATION_TEST_OVERRIDE];
  });

  it('orchestrator_completes_when_no_needsMigration_but_hasSkippedUnknownServerRows', async () => {
    migrationInspectMock.mockResolvedValue({
      needsMigration: false,
      hasSkippedUnknownServerRows: true,
      canRun: true,
      warnings: ['rows for removed servers were skipped'],
      unmappedEmptyBucket: false,
      library: { totalLegacyRows: 0, skippedUnknownServerRows: 12, tables: {} },
      analysis: { totalLegacyRows: 0, skippedUnknownServerRows: 4, tables: {} },
      mappings: [{ legacyId: 'legacy-a', indexKey: 'a.test' }],
    });

    renderHook(() => useMigrationOrchestrator());

    await waitFor(() => {
      expect(useMigrationStore.getState().phase).toBe('completed');
    });
    expect(useMigrationStore.getState().lastError).toBeNull();
  });

  it('done flag is set when no_needsMigration_and_hasSkippedUnknownServerRows', async () => {
    migrationInspectMock.mockResolvedValue({
      needsMigration: false,
      hasSkippedUnknownServerRows: true,
      canRun: true,
      warnings: ['rows for removed servers were skipped'],
      unmappedEmptyBucket: false,
      library: { totalLegacyRows: 0, skippedUnknownServerRows: 7, tables: {} },
      analysis: { totalLegacyRows: 0, skippedUnknownServerRows: 0, tables: {} },
      mappings: [{ legacyId: 'legacy-a', indexKey: 'a.test' }],
    });

    renderHook(() => useMigrationOrchestrator());

    await waitFor(() => {
      expect(useMigrationStore.getState().phase).toBe('completed');
    });
    expect(localStorage.getItem(DONE_FLAG)).toBe('1');
  });

  it('keeps completed phase on startup when done flag exists and no migration is needed', async () => {
    localStorage.setItem(DONE_FLAG, '1');
    useMigrationStore.setState({ phase: 'completed' });
    migrationInspectMock.mockResolvedValue({
      needsMigration: false,
      hasSkippedUnknownServerRows: false,
      canRun: true,
      warnings: [],
      unmappedEmptyBucket: false,
      library: { totalLegacyRows: 0, skippedUnknownServerRows: 0, tables: {} },
      analysis: { totalLegacyRows: 0, skippedUnknownServerRows: 0, tables: {} },
      mappings: [{ legacyId: 'legacy-a', indexKey: 'a.test' }],
    });

    renderHook(() => useMigrationOrchestrator());

    await waitFor(() => {
      expect(useMigrationStore.getState().phase).toBe('completed');
    });
    expect(migrationRunMock).not.toHaveBeenCalled();
    expect(rewriteFrontendStoreKeysMock).not.toHaveBeenCalled();
  });

  it('keeps startup non-blocking while genre-tags inspect is pending (no gate flash)', async () => {
    localStorage.setItem(DONE_FLAG, '1');
    migrationInspectMock.mockResolvedValue({
      needsMigration: false,
      hasSkippedUnknownServerRows: false,
      canRun: true,
      warnings: [],
      unmappedEmptyBucket: false,
      library: { totalLegacyRows: 0, skippedUnknownServerRows: 0, tables: {} },
      analysis: { totalLegacyRows: 0, skippedUnknownServerRows: 0, tables: {} },
      mappings: [{ legacyId: 'legacy-a', indexKey: 'a.test' }],
    });
    let resolveGenre: ((value: unknown) => void) | undefined;
    libraryGenreTagsInspectMock.mockImplementation(
      () => new Promise(resolve => { resolveGenre = resolve; }),
    );

    renderHook(() => useMigrationOrchestrator());

    // Server-index precheck resolved; genre inspect still pending. The gate must
    // not be blocking (phase stays 'idle', never 'inspecting'/'running').
    await waitFor(() => {
      expect(libraryGenreTagsInspectMock).toHaveBeenCalled();
    });
    expect(useMigrationStore.getState().phase).toBe('idle');

    if (!resolveGenre) throw new Error('genre inspect resolver not captured');
    resolveGenre({ needed: false, totalTracks: 100, doneTracks: 100 });

    await waitFor(() => {
      expect(useMigrationStore.getState().phase).toBe('completed');
    });
  });

  it('keeps startup non-blocking while done-flag precheck is pending', async () => {
    localStorage.setItem(DONE_FLAG, '1');
    let resolveInspect: ((value: unknown) => void) | undefined;
    migrationInspectMock.mockImplementation(
      () => new Promise(resolve => { resolveInspect = resolve; }),
    );

    renderHook(() => useMigrationOrchestrator());

    await waitFor(() => {
      expect(useMigrationStore.getState().phase).toBe('idle');
    });
    expect(migrationRunMock).not.toHaveBeenCalled();

    if (!resolveInspect) throw new Error('inspect resolver not captured');
    resolveInspect({
      needsMigration: false,
      hasSkippedUnknownServerRows: false,
      canRun: true,
      warnings: [],
      unmappedEmptyBucket: false,
      library: { totalLegacyRows: 0, skippedUnknownServerRows: 0, tables: {} },
      analysis: { totalLegacyRows: 0, skippedUnknownServerRows: 0, tables: {} },
      mappings: [{ legacyId: 'legacy-a', indexKey: 'a.test' }],
    });

    await waitFor(() => {
      expect(useMigrationStore.getState().phase).toBe('completed');
    });
  });
});
