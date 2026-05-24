import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
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
    state.setPhase(force ? 'inspecting' : 'idle');
    let inspect = null as Awaited<ReturnType<typeof migrationInspect>> | null;
    if (!force && hasDoneFlag) {
      inspect = await migrationInspect(mappings);
      state.setInspect(inspect);
      state.setNeedsMigration(inspect.needsMigration);
      skippedLogged = logSkippedUnknownRowsOnce(inspect, skippedLogged);
      if (!inspect.needsMigration) {
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
    skippedLogged = logSkippedUnknownRowsOnce(after, skippedLogged);
    if (!after.needsMigration) {
      localStorage.setItem(MIGRATION_DONE_FLAG, '1');
      state.setPhase('completed');
      return;
    }
    state.setError('Migration incomplete. Retry after adding missing server mapping.');
    state.setPhase('error');
  })()
    .catch((error: unknown) => {
      useMigrationStore.getState().setError(String(error));
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

export function useMigrationOrchestrator(): void {
  const servers = useAuthStore(s => s.servers);

  useEffect(() => {
    let disposed = false;
    const sub = listen('migration:progress', (event) => {
      if (disposed) return;
      useMigrationStore.getState().setProgress(event.payload as {
        stage: string;
        table: string;
        done: number;
        total: number;
      });
    });
    return () => {
      disposed = true;
      void sub.then(unlisten => unlisten());
    };
  }, []);

  useEffect(() => {
    void runOrchestrator();
  }, [servers]);
}
