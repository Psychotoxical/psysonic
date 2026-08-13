import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { useMigrationStore } from '@/store/migrationStore';

const migrationInspectMock = vi.fn();
const migrationRunMock = vi.fn();
const libraryGenreTagsInspectMock = vi.fn();
const libraryGenreTagsRunMock = vi.fn();
const libraryScopeBrowseProjectionInspectMock = vi.fn();
const libraryScopeBrowseProjectionRunMock = vi.fn();
const libraryNavidromeCanonicalInspectMock = vi.fn();
const bindIndexedServerForMigrationMock = vi.fn();
const enqueueLibrarySyncMock = vi.fn();
const libraryNavidromeCanonicalRewriteMock = vi.fn();
const libraryNavidromeCanonicalAckFrontendMock = vi.fn();
const libraryNavidromeCanonicalFinalizeMock = vi.fn();
const rewriteNavidromeCanonicalFrontendStateMock = vi.fn();
const audioStopMock = vi.fn();
const analysisDeleteAllForServerMock = vi.fn();
const rewriteFrontendStoreKeysMock = vi.fn(async (_servers: unknown) => undefined);

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('@/lib/api/migration', () => ({
  migrationInspect: (mappings: unknown) => migrationInspectMock(mappings),
  migrationRun: (mappings: unknown) => migrationRunMock(mappings),
}));

vi.mock('@/lib/api/library', () => ({
  libraryGenreTagsInspect: () => libraryGenreTagsInspectMock(),
  libraryGenreTagsRun: () => libraryGenreTagsRunMock(),
  libraryScopeBrowseProjectionInspect: () => libraryScopeBrowseProjectionInspectMock(),
  libraryScopeBrowseProjectionRun: () => libraryScopeBrowseProjectionRunMock(),
  libraryNavidromeCanonicalInspect: () => libraryNavidromeCanonicalInspectMock(),
  libraryNavidromeCanonicalRewrite: (...args: unknown[]) => libraryNavidromeCanonicalRewriteMock(...args),
  libraryNavidromeCanonicalAckFrontend: (...args: unknown[]) => libraryNavidromeCanonicalAckFrontendMock(...args),
  libraryNavidromeCanonicalFinalize: (...args: unknown[]) => libraryNavidromeCanonicalFinalizeMock(...args),
}));

vi.mock('@/lib/library/librarySession', () => ({
  bindIndexedServerForMigration: (...args: unknown[]) => bindIndexedServerForMigrationMock(...args),
}));

vi.mock('@/lib/library/librarySyncQueue', () => ({
  enqueueLibrarySync: (...args: unknown[]) => enqueueLibrarySyncMock(...args),
}));

vi.mock('@/lib/api/audio', () => ({ audioStop: (...args: unknown[]) => audioStopMock(...args) }));
vi.mock('@/lib/api/analysis', () => ({
  analysisDeleteAllForServer: (...args: unknown[]) => analysisDeleteAllForServerMock(...args),
}));
vi.mock('@/cover/imageCache', () => ({ clearImageCache: vi.fn() }));
vi.mock('@/lib/api/coverCache', () => ({ coverCacheClearServer: vi.fn() }));
vi.mock('@/features/lyrics/utils/lyricsPersistentCache', () => ({ clearLyricsCache: vi.fn() }));
vi.mock('@/features/home/store/homeFeedCache', () => ({ clearHomeFeedCache: vi.fn() }));
vi.mock('@/features/home/store/becauseYouLikeCache', () => ({ clearBecauseYouLikeCache: vi.fn() }));
vi.mock('@/app/migrations/navidromeCanonicalFrontend', () => ({
  rewriteNavidromeCanonicalFrontendState: (...args: unknown[]) => rewriteNavidromeCanonicalFrontendStateMock(...args),
}));

vi.mock('@/utils/server/rewriteFrontendStoreKeys', () => ({
  rewriteFrontendStoreKeys: (servers: unknown) => rewriteFrontendStoreKeysMock(servers),
}));

import { useMigrationOrchestrator } from '@/app/hooks/useMigrationOrchestrator';

const DONE_FLAG = 'psysonic-server-key-migration-v1';
const REAL_MIGRATION_TEST_OVERRIDE = '__PSYSONIC_REAL_MIGRATION_TEST__';

describe('useMigrationOrchestrator', () => {
  beforeEach(() => {
    migrationInspectMock.mockReset();
    migrationRunMock.mockReset();
    libraryGenreTagsInspectMock.mockReset();
    libraryGenreTagsRunMock.mockReset();
    libraryScopeBrowseProjectionInspectMock.mockReset();
    libraryScopeBrowseProjectionRunMock.mockReset();
    libraryNavidromeCanonicalInspectMock.mockReset().mockResolvedValue({
      serverId: 'a.test',
      state: 'not_applicable',
      canonicalVersion: 1,
      probeKind: null,
      probeOldId: null,
      probeNewId: null,
      lastError: null,
      mappings: [],
    });
    bindIndexedServerForMigrationMock.mockReset().mockResolvedValue('bound');
    enqueueLibrarySyncMock.mockReset().mockResolvedValue(undefined);
    libraryNavidromeCanonicalRewriteMock.mockReset();
    libraryNavidromeCanonicalAckFrontendMock.mockReset();
    libraryNavidromeCanonicalFinalizeMock.mockReset();
    rewriteNavidromeCanonicalFrontendStateMock.mockReset().mockResolvedValue(undefined);
    audioStopMock.mockReset().mockResolvedValue(undefined);
    analysisDeleteAllForServerMock.mockReset().mockResolvedValue({ analysisTracks: 0, waveforms: 0, loudness: 0 });
    libraryGenreTagsInspectMock.mockResolvedValue({ needed: false, totalTracks: 0, doneTracks: 0 });
    libraryGenreTagsRunMock.mockResolvedValue(undefined);
    libraryScopeBrowseProjectionInspectMock.mockResolvedValue({ needed: false, totalTracks: 0, doneTracks: 0 });
    libraryScopeBrowseProjectionRunMock.mockResolvedValue(undefined);
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
      scopeBrowseProjectionInspect: null,
      scopeBrowseProjectionProgress: null,
      navidromeCanonical: null,
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

  it('keeps startup non-blocking while scope-browse projection inspect is pending', async () => {
    localStorage.setItem(DONE_FLAG, '1');
    migrationInspectMock.mockResolvedValue({
      needsMigration: false, hasSkippedUnknownServerRows: false, canRun: true, warnings: [],
      unmappedEmptyBucket: false,
      library: { totalLegacyRows: 0, skippedUnknownServerRows: 0, tables: {} },
      analysis: { totalLegacyRows: 0, skippedUnknownServerRows: 0, tables: {} },
      mappings: [{ legacyId: 'legacy-a', indexKey: 'a.test' }],
    });
    let resolveProjection: ((value: unknown) => void) | undefined;
    libraryScopeBrowseProjectionInspectMock.mockImplementation(
      () => new Promise(resolve => { resolveProjection = resolve; }),
    );

    renderHook(() => useMigrationOrchestrator());

    await waitFor(() => {
      expect(libraryScopeBrowseProjectionInspectMock).toHaveBeenCalledTimes(1);
    });
    expect(useMigrationStore.getState().phase).toBe('idle');

    if (!resolveProjection) throw new Error('projection inspect resolver not captured');
    resolveProjection({ needed: false, totalTracks: 100, doneTracks: 100 });

    await waitFor(() => {
      expect(useMigrationStore.getState().phase).toBe('completed');
    });
  });

  it('keeps normal startup blocked through rewrite, frontend persistence, full sync, and finalize', async () => {
    migrationInspectMock.mockResolvedValue({
      needsMigration: false, hasSkippedUnknownServerRows: false, canRun: true, warnings: [],
      unmappedEmptyBucket: false,
      library: { totalLegacyRows: 0, skippedUnknownServerRows: 0, tables: {} },
      analysis: { totalLegacyRows: 0, skippedUnknownServerRows: 0, tables: {} },
      mappings: [{ legacyId: 'legacy-a', indexKey: 'a.test' }],
    });
    const mapping = { entityKind: 'track', oldId: 'old', newId: 'new' };
    libraryNavidromeCanonicalInspectMock
      .mockResolvedValueOnce({
        serverId: 'a.test', state: 'required', canonicalVersion: 1,
        probeKind: 'track', probeOldId: 'old', probeNewId: 'new', lastError: null,
        mappings: [mapping],
      })
      .mockResolvedValueOnce({
        serverId: 'a.test', state: 'resyncing', canonicalVersion: 1,
        probeKind: 'track', probeOldId: 'old', probeNewId: 'new', lastError: null,
        mappings: [mapping],
      });
    libraryNavidromeCanonicalRewriteMock.mockResolvedValue({
      serverId: 'a.test', state: 'frontend', canonicalVersion: 1,
      probeKind: 'track', probeOldId: 'old', probeNewId: 'new', lastError: null,
      mappings: [mapping],
    });
    libraryNavidromeCanonicalAckFrontendMock.mockResolvedValue({
      serverId: 'a.test', state: 'resyncing', canonicalVersion: 1,
      probeKind: 'track', probeOldId: 'old', probeNewId: 'new', lastError: null,
      mappings: [mapping],
    });
    libraryNavidromeCanonicalFinalizeMock.mockResolvedValue({
      serverId: 'a.test', state: 'ready', canonicalVersion: 1,
      probeKind: 'track', probeOldId: 'old', probeNewId: 'new', lastError: null,
      mappings: [],
    });

    renderHook(() => useMigrationOrchestrator());

    await waitFor(() => expect(useMigrationStore.getState().phase).toBe('completed'));
    expect(libraryNavidromeCanonicalRewriteMock).toHaveBeenCalledWith('a.test');
    expect(rewriteNavidromeCanonicalFrontendStateMock).toHaveBeenCalled();
    expect(analysisDeleteAllForServerMock).toHaveBeenCalledWith('a.test');
    expect(libraryNavidromeCanonicalAckFrontendMock).toHaveBeenCalledWith('a.test');
    expect(enqueueLibrarySyncMock).toHaveBeenCalledWith({ serverId: 'a.test', kind: 'full' });
    expect(libraryNavidromeCanonicalFinalizeMock).toHaveBeenCalledWith('a.test');
  });

  it('keeps the gate in error when the required full sync fails', async () => {
    migrationInspectMock.mockResolvedValue({
      needsMigration: false, hasSkippedUnknownServerRows: false, canRun: true, warnings: [],
      unmappedEmptyBucket: false,
      library: { totalLegacyRows: 0, skippedUnknownServerRows: 0, tables: {} },
      analysis: { totalLegacyRows: 0, skippedUnknownServerRows: 0, tables: {} },
      mappings: [{ legacyId: 'legacy-a', indexKey: 'a.test' }],
    });
    libraryNavidromeCanonicalInspectMock.mockResolvedValue({
      serverId: 'a.test', state: 'resyncing', canonicalVersion: 1,
      probeKind: null, probeOldId: null, probeNewId: null, lastError: null, mappings: [],
    });
    enqueueLibrarySyncMock.mockRejectedValue(new Error('sync failed'));

    renderHook(() => useMigrationOrchestrator());

    await waitFor(() => expect(useMigrationStore.getState().phase).toBe('error'));
    expect(useMigrationStore.getState().step).toBe('navidromeCanonical');
    expect(useMigrationStore.getState().lastError).toBe('sync failed');
    expect(libraryNavidromeCanonicalFinalizeMock).not.toHaveBeenCalled();
  });

  it('allows offline startup for a durable terminal canonical state', async () => {
    migrationInspectMock.mockResolvedValue({
      needsMigration: false, hasSkippedUnknownServerRows: false, canRun: true, warnings: [],
      unmappedEmptyBucket: false,
      library: { totalLegacyRows: 0, skippedUnknownServerRows: 0, tables: {} },
      analysis: { totalLegacyRows: 0, skippedUnknownServerRows: 0, tables: {} },
      mappings: [{ legacyId: 'legacy-a', indexKey: 'a.test' }],
    });
    bindIndexedServerForMigrationMock.mockResolvedValue('offline');
    libraryNavidromeCanonicalInspectMock.mockResolvedValue({
      serverId: 'a.test', state: 'ready', canonicalVersion: 1,
      probeKind: null, probeOldId: null, probeNewId: null, lastError: null, mappings: [],
    });

    renderHook(() => useMigrationOrchestrator());

    await waitFor(() => expect(useMigrationStore.getState().phase).toBe('completed'));
    expect(rewriteNavidromeCanonicalFrontendStateMock).toHaveBeenCalled();
  });
});
