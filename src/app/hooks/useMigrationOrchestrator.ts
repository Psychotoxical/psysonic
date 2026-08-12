import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  libraryGenreTagsInspect,
  libraryGenreTagsRun,
  libraryScopeBrowseProjectionInspect,
  libraryScopeBrowseProjectionRun,
} from '@/lib/api/library';
import { migrationInspect, migrationRun, type ServerIndexMapping } from '@/lib/api/migration';
import { useAuthStore } from '@/store/authStore';
import { useMigrationStore } from '@/store/migrationStore';
import {
  enqueueBlockingMigration,
  blockingMigrationStatus,
  retryCurrentBlockingMigration,
  type BlockingMigrationContext,
} from '@/store/migrationCoordinator';
import { serverIndexKeyFromUrl } from '@/lib/server/serverIndexKey';
import { rewriteFrontendStoreKeys } from '@/utils/server/rewriteFrontendStoreKeys';

const MIGRATION_DONE_FLAG = 'psysonic-server-key-migration-v1';
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

async function runGenreTagsPhase(context: BlockingMigrationContext): Promise<void> {
  const state = useMigrationStore.getState();
  state.setGenreTagsProgress(null);

  // Inspect first WITHOUT entering a blocking phase. An already-migrated launch
  // must not flash the gate while this inspect IPC round-trips (regression: the
  // modal briefly appeared on every startup once the backfill was complete).
  const inspect = await libraryGenreTagsInspect();
  state.setGenreTagsInspect(inspect);
  if (!inspect.needed) return;

  context.setView({ step: 'genreTags', needsMigration: true, phase: 'running' });
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await libraryGenreTagsRun();
    const after = await libraryGenreTagsInspect();
    state.setGenreTagsInspect(after);
    if (!after.needed) {
      state.setGenreTagsProgress(null);
      return;
    }
  }
  const after = await libraryGenreTagsInspect();
  if (after.needed) {
    throw new Error('Genre index update incomplete. Retry after restart.');
  }
}

async function runScopeBrowseProjectionPhase(context: BlockingMigrationContext): Promise<void> {
  const state = useMigrationStore.getState();
  state.setScopeBrowseProjectionProgress(null);
  const inspect = await libraryScopeBrowseProjectionInspect();
  state.setScopeBrowseProjectionInspect(inspect);
  if (!inspect.needed) return;

  context.setView({ step: 'scopeBrowseProjection', needsMigration: true, phase: 'running' });
  await libraryScopeBrowseProjectionRun();
  const after = await libraryScopeBrowseProjectionInspect();
  state.setScopeBrowseProjectionInspect(after);
  if (after.needed) {
    throw new Error('Library browse index update incomplete. Retry after restart.');
  }
  state.setScopeBrowseProjectionProgress(null);
}

async function runOrchestrator(force = false): Promise<void> {
  const promise = enqueueBlockingMigration({
    id: 'ordinary-migrations',
    step: 'serverIndex',
    initialPhase: force ? 'inspecting' : 'idle',
    retry: () => { void runOrchestrator(true); },
    run: async (context) => {
      const state = useMigrationStore.getState();
      let skippedLogged = false;
      if (import.meta.env.MODE === 'test' && !(globalThis as Record<string, unknown>)[REAL_MIGRATION_TEST_OVERRIDE]) {
        return;
      }
      const servers = useAuthStore.getState().servers;
      if (servers.length === 0) {
        return;
      }
      const mappings = buildMappings();
      const hasDoneFlag = localStorage.getItem(MIGRATION_DONE_FLAG) === '1';
      state.setProgress(null);
      state.setGenreTagsProgress(null);
      context.setView({
        step: 'serverIndex',
        needsMigration: false,
        phase: force ? 'inspecting' : 'idle',
      });
      let inspect = null as Awaited<ReturnType<typeof migrationInspect>> | null;
      if (!force && hasDoneFlag) {
        inspect = await migrationInspect(mappings);
        state.setInspect(inspect);
        state.setNeedsMigration(inspect.needsMigration);
        skippedLogged = logSkippedUnknownRowsOnce(inspect, skippedLogged);
        if (!inspect.needsMigration) {
          await runGenreTagsPhase(context);
          await runScopeBrowseProjectionPhase(context);
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
        await runGenreTagsPhase(context);
        await runScopeBrowseProjectionPhase(context);
        return;
      }
      context.setView({ step: 'serverIndex', needsMigration: true, phase: 'running' });
      await migrationRun(mappings);
      await rewriteFrontendStoreKeys(servers);
      context.setView({ phase: 'inspecting' });
      const after = await migrationInspect(mappings);
      state.setInspect(after);
      state.setNeedsMigration(after.needsMigration);
      logSkippedUnknownRowsOnce(after, skippedLogged);
      if (!after.needsMigration) {
        localStorage.setItem(MIGRATION_DONE_FLAG, '1');
        await runGenreTagsPhase(context);
        await runScopeBrowseProjectionPhase(context);
        return;
      }
      throw new Error('Migration incomplete. Retry after adding missing server mapping.');
    },
  });
  await promise.catch(() => {});
}

export function retryServerIndexMigration(): void {
  void runOrchestrator(true);
}

export function retryGenreTagsMigration(): void {
  void runOrchestrator(true);
}

export function retryBlockingMigration(): void {
  retryCurrentBlockingMigration();
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
    if (blockingMigrationStatus('ordinary-migrations') === 'failed') return;
    void runOrchestrator();
  }, [servers]);
}
