import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { libraryGenreTagsInspect, libraryGenreTagsRun } from '../api/library';
import { migrationInspect, migrationRun, type ServerIndexMapping } from '../api/migration';
import { useAuthStore } from '../store/authStore';
import { useMigrationStore } from '../store/migrationStore';
import { serverIndexKeyFromUrl } from '../utils/server/serverIndexKey';
import { rewriteFrontendStoreKeys } from '../utils/server/rewriteFrontendStoreKeys';

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
    const mappings = buildMappings();
    const hasDoneFlag = localStorage.getItem(MIGRATION_DONE_FLAG) === '1';
    state.setError(null);
    state.setProgress(null);
    state.setGenreTagsProgress(null);
    state.setStep('serverIndex');
    state.setPhase(force ? 'inspecting' : 'idle');
    let inspect = null as Awaited<ReturnType<typeof migrationInspect>> | null;
    if (!force && hasDoneFlag) {
      inspect = await migrationInspect(mappings);
      state.setInspect(inspect);
      state.setNeedsMigration(inspect.needsMigration);
      skippedLogged = logSkippedUnknownRowsOnce(inspect, skippedLogged);
      if (!inspect.needsMigration) {
        await runGenreTagsPhase();
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
      await runGenreTagsPhase();
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
      await runGenreTagsPhase();
      state.setPhase('completed');
      return;
    }
    state.setError('Migration incomplete. Retry after adding missing server mapping.');
    state.setPhase('error');
  })()
    .catch((error: unknown) => {
      if (!(error instanceof Error && error.message === 'genre_tags_incomplete')) {
        useMigrationStore.getState().setError(String(error));
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
        state.setError(String(error));
      }
      state.setPhase('error');
    }
  })().finally(() => {
    migrationInFlight = null;
  });
}

export function retryBlockingMigration(): void {
  const step = useMigrationStore.getState().step;
  if (step === 'genreTags') {
    retryGenreTagsMigration();
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
