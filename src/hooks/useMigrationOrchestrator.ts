import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { migrationInspect, migrationRun, type ServerIndexMapping } from '../api/migration';
import { useAuthStore } from '../store/authStore';
import { useMigrationStore } from '../store/migrationStore';
import { serverIndexKeyFromUrl } from '../utils/server/serverIndexKey';
import { rewriteFrontendStoreKeys } from '../utils/server/rewriteFrontendStoreKeys';

const MIGRATION_DONE_FLAG = 'psysonic-server-key-migration-v1';
let migrationInFlight: Promise<void> | null = null;

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
    if (import.meta.env.MODE === 'test') {
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
    if (!force && localStorage.getItem(MIGRATION_DONE_FLAG) === '1') {
      state.setNeedsMigration(false);
      state.setPhase('completed');
      return;
    }
    const mappings = buildMappings();
    state.setError(null);
    state.setProgress(null);
    state.setPhase('inspecting');
    const inspect = await migrationInspect(mappings);
    state.setInspect(inspect);
    state.setNeedsMigration(inspect.needsMigration);
    if (!inspect.needsMigration) {
      await rewriteFrontendStoreKeys(servers);
      localStorage.setItem(MIGRATION_DONE_FLAG, '1');
      state.setPhase('completed');
      return;
    }
    state.setPhase('running');
    await migrationRun(mappings);
    await rewriteFrontendStoreKeys(servers);
    localStorage.setItem(MIGRATION_DONE_FLAG, '1');
    state.setPhase('completed');
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
