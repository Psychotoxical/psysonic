import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  libraryGenreTagsInspect,
  libraryGenreTagsRun,
  libraryNavidromeCanonicalAckFrontend,
  libraryNavidromeCanonicalFinalize,
  libraryNavidromeCanonicalInspect,
  libraryNavidromeCanonicalRewrite,
  libraryScopeBrowseProjectionInspect,
  libraryScopeBrowseProjectionRun,
} from '@/lib/api/library';
import { migrationInspect, migrationRun, type ServerIndexMapping } from '@/lib/api/migration';
import { useAuthStore } from '@/store/authStore';
import { useMigrationStore } from '@/store/migrationStore';
import { serverIndexKeyFromUrl } from '@/lib/server/serverIndexKey';
import { rewriteFrontendStoreKeys } from '@/utils/server/rewriteFrontendStoreKeys';
import { bindIndexedServerForMigration } from '@/lib/library/librarySession';
import { enqueueLibrarySync } from '@/lib/library/librarySyncQueue';
import { serverIndexKeyForProfile } from '@/lib/server/serverIndexKey';
import { rewriteNavidromeCanonicalFrontendState } from '@/app/migrations/navidromeCanonicalFrontend';
import { useOfflineJobStore } from '@/features/offline/store/offlineJobStore';
import { clearOfflinePinTasks } from '@/features/offline/utils/offlinePinQueue';
import { audioStop } from '@/lib/api/audio';
import { clearImageCache } from '@/cover/imageCache';
import { coverCacheClearServer } from '@/lib/api/coverCache';
import { clearLyricsCache } from '@/features/lyrics/utils/lyricsPersistentCache';
import { clearHomeFeedCache } from '@/features/home/store/homeFeedCache';
import { clearBecauseYouLikeCache } from '@/features/home/store/becauseYouLikeCache';
import { analysisDeleteAllForServer } from '@/lib/api/analysis';

const MIGRATION_DONE_FLAG = 'psysonic-server-key-migration-v1';
let migrationInFlight: Promise<void> | null = null;
const REAL_MIGRATION_TEST_OVERRIDE = '__PSYSONIC_REAL_MIGRATION_TEST__';

function logSkippedUnknownRowsOnce(
  report: Awaited<ReturnType<typeof migrationInspect>>,
  alreadyLogged: boolean,
): boolean {
  if (!alreadyLogged && report.hasSkippedUnknownServerRows) {
    console.warn('[migration] rows for removed servers were skipped');
    return true;
  }
  return alreadyLogged;
}

function buildMappings(): ServerIndexMapping[] {
  return useAuthStore.getState().servers
    .map(server => ({
      legacyId: server.id,
      indexKey: serverIndexKeyFromUrl(server.url),
    }))
    .filter(mapping => mapping.legacyId.trim().length > 0 && mapping.indexKey.trim().length > 0);
}

async function runGenreTagsPhase(): Promise<void> {
  const state = useMigrationStore.getState();
  state.setGenreTagsProgress(null);

  // Inspect first WITHOUT entering a blocking phase. An already-migrated launch
  // must not flash the gate while this inspect IPC round-trips (regression: the
  // modal briefly appeared on every startup once the backfill was complete).
  const inspect = await libraryGenreTagsInspect();
  state.setGenreTagsInspect(inspect);
  if (!inspect.needed) {
    state.setStep(null);
    return;
  }

  state.setStep('genreTags');
  state.setError(null);
  state.setPhase('running');
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await libraryGenreTagsRun();
    const after = await libraryGenreTagsInspect();
    state.setGenreTagsInspect(after);
    if (!after.needed) {
      state.setStep(null);
      state.setGenreTagsProgress(null);
      return;
    }
  }
  const after = await libraryGenreTagsInspect();
  if (after.needed) {
    state.setError('Genre index update incomplete. Retry after restart.');
    state.setPhase('error');
    throw new Error('genre_tags_incomplete');
  }
}

async function runScopeBrowseProjectionPhase(): Promise<void> {
  const state = useMigrationStore.getState();
  state.setScopeBrowseProjectionProgress(null);
  const inspect = await libraryScopeBrowseProjectionInspect();
  state.setScopeBrowseProjectionInspect(inspect);
  if (!inspect.needed) return;

  state.setStep('scopeBrowseProjection');
  state.setError(null);
  state.setPhase('running');
  await libraryScopeBrowseProjectionRun();
  const after = await libraryScopeBrowseProjectionInspect();
  state.setScopeBrowseProjectionInspect(after);
  if (after.needed) {
    state.setError('Library browse index update incomplete. Retry after restart.');
    state.setPhase('error');
    throw new Error('scope_browse_projection_incomplete');
  }
  state.setStep(null);
  state.setScopeBrowseProjectionProgress(null);
}

async function runNavidromeCanonicalPhase(): Promise<void> {
  const state = useMigrationStore.getState();
  const servers = useAuthStore.getState().servers;
  if (servers.length !== 1) {
    const existing = state.navidromeCanonical;
    if (existing && existing.state !== 'legacy' && existing.state !== 'ready') {
      state.setStep('navidromeCanonical');
      state.setPhase('error');
      throw new Error('Canonical-ID migration requires exactly one configured server.');
    }
    return;
  }
  const server = servers[0]!;
  const serverId = serverIndexKeyForProfile(server);
  if (!serverId) throw new Error('The Navidrome migration requires a stable server index key.');

  const bound = await bindIndexedServerForMigration(server);
  let migration = await libraryNavidromeCanonicalInspect(serverId);
  state.setNavidromeCanonical(migration);
  if (bound !== 'bound' && !['legacy', 'not_applicable', 'ready'].includes(migration.state)) {
    throw new Error('The configured server must be reachable before migration.');
  }
  if (migration.state === 'ready') {
    await rewriteNavidromeCanonicalFrontendState(migration);
    return;
  }
  if (migration.state === 'not_applicable' || migration.state === 'legacy') return;

  state.setStep('navidromeCanonical');
  state.setPhase('running');
  if (migration.state === 'required' || migration.state === 'rewriting') {
    useOfflineJobStore.getState().cancelAllDownloads();
    clearOfflinePinTasks();
    await audioStop().catch(() => {});
    migration = await libraryNavidromeCanonicalRewrite(serverId);
    state.setNavidromeCanonical(migration);
  }
  if (migration.state === 'frontend') {
    await rewriteNavidromeCanonicalFrontendState(migration);
    await analysisDeleteAllForServer(serverId);
    await Promise.all([
      clearImageCache(),
      clearLyricsCache(),
      coverCacheClearServer(serverId),
    ]);
    clearHomeFeedCache();
    clearBecauseYouLikeCache();
    migration = await libraryNavidromeCanonicalAckFrontend(serverId);
    state.setNavidromeCanonical(migration);
  }
  if (migration.state === 'resyncing') {
    await rewriteNavidromeCanonicalFrontendState(migration);
    await analysisDeleteAllForServer(serverId);
    await enqueueLibrarySync({ serverId, kind: 'full' });
    migration = await libraryNavidromeCanonicalInspect(serverId);
    state.setNavidromeCanonical(migration);
    if (migration.state === 'legacy') {
      state.setStep(null);
      return;
    }
    migration = await libraryNavidromeCanonicalFinalize(serverId);
    state.setNavidromeCanonical(migration);
  }
  if (migration.state !== 'ready') {
    throw new Error(migration.lastError ?? `Canonical-ID migration stopped in ${migration.state}`);
  }
  state.setStep(null);
}

async function runOrchestrator(force = false): Promise<void> {
  if (migrationInFlight) {
    await migrationInFlight;
    return;
  }
  migrationInFlight = (async () => {
    const state = useMigrationStore.getState();
    let skippedLogged = false;
    if (import.meta.env.MODE === 'test' && !(globalThis as Record<string, unknown>)[REAL_MIGRATION_TEST_OVERRIDE]) {
      state.setNeedsMigration(false);
      state.setPhase('completed');
      return;
    }
    const servers = useAuthStore.getState().servers;
    if (servers.length === 0) {
      state.setNeedsMigration(false);
      state.setPhase('completed');
      return;
    }
    if (servers.length !== 1) {
      state.setStep('navidromeCanonical');
      state.setError('Canonical-ID preflight requires exactly one configured server.');
      state.setPhase('error');
      return;
    }
    const mappings = buildMappings();
    const hasDoneFlag = localStorage.getItem(MIGRATION_DONE_FLAG) === '1';
    state.setError(null);
    state.setProgress(null);
    state.setGenreTagsProgress(null);
    state.setNavidromeCanonical(null);
    state.setStep('serverIndex');
    state.setPhase(force ? 'inspecting' : 'idle');
    let inspect = null as Awaited<ReturnType<typeof migrationInspect>> | null;
    if (!force && hasDoneFlag) {
      inspect = await migrationInspect(mappings);
      state.setInspect(inspect);
      state.setNeedsMigration(inspect.needsMigration);
      skippedLogged = logSkippedUnknownRowsOnce(inspect, skippedLogged);
      if (!inspect.needsMigration) {
        await runNavidromeCanonicalPhase();
        await runGenreTagsPhase();
        await runScopeBrowseProjectionPhase();
        state.setPhase('completed');
        return;
      }
    }
    if (!inspect) {
      inspect = await migrationInspect(mappings);
    }
    state.setInspect(inspect);
    state.setNeedsMigration(inspect.needsMigration);
    skippedLogged = logSkippedUnknownRowsOnce(inspect, skippedLogged);
    if (!inspect.needsMigration) {
      await rewriteFrontendStoreKeys(servers);
      localStorage.setItem(MIGRATION_DONE_FLAG, '1');
      await runNavidromeCanonicalPhase();
      await runGenreTagsPhase();
      await runScopeBrowseProjectionPhase();
      state.setPhase('completed');
      return;
    }
    state.setPhase('inspecting');
    state.setPhase('running');
    await migrationRun(mappings);
    await rewriteFrontendStoreKeys(servers);
    state.setPhase('inspecting');
    const after = await migrationInspect(mappings);
    state.setInspect(after);
    state.setNeedsMigration(after.needsMigration);
    logSkippedUnknownRowsOnce(after, skippedLogged);
    if (!after.needsMigration) {
      localStorage.setItem(MIGRATION_DONE_FLAG, '1');
        await runNavidromeCanonicalPhase();
        await runGenreTagsPhase();
        await runScopeBrowseProjectionPhase();
      state.setPhase('completed');
      return;
    }
    state.setError('Migration incomplete. Retry after adding missing server mapping.');
    state.setPhase('error');
  })()
    .catch((error: unknown) => {
      if (!(error instanceof Error && error.message === 'genre_tags_incomplete')) {
        useMigrationStore.getState().setError(error instanceof Error ? error.message : String(error));
      }
      useMigrationStore.getState().setPhase('error');
    })
    .finally(() => {
      migrationInFlight = null;
    });
  await migrationInFlight;
}

export function retryServerIndexMigration(): void {
  void runOrchestrator(true);
}

export function retryGenreTagsMigration(): void {
  if (migrationInFlight) {
    void migrationInFlight.then(() => retryGenreTagsMigration());
    return;
  }
  migrationInFlight = (async () => {
    const state = useMigrationStore.getState();
    state.setError(null);
    state.setGenreTagsProgress(null);
    try {
      await runGenreTagsPhase();
      state.setPhase('completed');
    } catch (error: unknown) {
      if (!(error instanceof Error && error.message === 'genre_tags_incomplete')) {
        state.setError(error instanceof Error ? error.message : String(error));
      }
      state.setPhase('error');
    }
  })().finally(() => {
    migrationInFlight = null;
  });
}

export function retryBlockingMigration(): void {
  const step = useMigrationStore.getState().step;
  if (step === 'navidromeCanonical') {
    void runOrchestrator(true);
    return;
  }
  if (step === 'genreTags') {
    retryGenreTagsMigration();
    return;
  }
  if (step === 'scopeBrowseProjection') {
    void runOrchestrator();
    return;
  }
  retryServerIndexMigration();
}

export function useMigrationOrchestrator(): void {
  const servers = useAuthStore(s => s.servers);

  useEffect(() => {
    let disposed = false;
    const subs = [
      listen('migration:progress', (event) => {
        if (disposed) return;
        useMigrationStore.getState().setProgress(event.payload as {
          stage: string;
          table: string;
          done: number;
          total: number;
        });
      }),
      listen('genre_tags:progress', (event) => {
        if (disposed) return;
        useMigrationStore.getState().setGenreTagsProgress(event.payload as {
          done: number;
          total: number;
        });
      }),
      listen('scope_browse_projection:progress', (event) => {
        if (disposed) return;
        useMigrationStore.getState().setScopeBrowseProjectionProgress(event.payload as {
          done: number;
          total: number;
        });
      }),
    ];
    return () => {
      disposed = true;
      void Promise.all(subs).then(unlisteners => unlisteners.forEach(unlisten => unlisten()));
    };
  }, []);

  useEffect(() => {
    void runOrchestrator();
  }, [servers]);
}
