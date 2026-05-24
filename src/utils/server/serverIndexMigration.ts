import { useAuthStore } from '../../store/authStore';
import { useAnalysisStrategyStore } from '../../store/analysisStrategyStore';
import { analysisMigrateServerIndexKeys } from '../../api/analysis';
import { libraryMigrateServerIndexKeys } from '../../api/library';
import { serverIndexKeyFromUrl } from './serverIndexKey';

let lastMigrationSignature = '';
let migrationInFlight: Promise<void> | null = null;

export async function migrateServerIndexKeysIfNeeded(): Promise<void> {
  if (migrationInFlight) {
    await migrationInFlight;
    return;
  }
  const servers = useAuthStore.getState().servers;
  if (servers.length === 0) return;
  const mappings = servers
    .map(server => ({
      legacyId: server.id,
      indexKey: serverIndexKeyFromUrl(server.url),
    }))
    .filter(m => m.legacyId.trim().length > 0 && m.indexKey.trim().length > 0);
  mappings.sort((a, b) => a.legacyId.localeCompare(b.legacyId));
  const signature = JSON.stringify(mappings);
  if (signature === lastMigrationSignature) return;
  lastMigrationSignature = signature;

  migrationInFlight = (async () => {
    try {
      await libraryMigrateServerIndexKeys(mappings);
    } catch {
      /* best-effort */
    }
    try {
      await analysisMigrateServerIndexKeys(mappings);
    } catch {
      /* best-effort */
    }
    useAnalysisStrategyStore.getState().migrateServerOverrides(servers);
  })();
  try {
    await migrationInFlight;
  } finally {
    migrationInFlight = null;
  }
}
