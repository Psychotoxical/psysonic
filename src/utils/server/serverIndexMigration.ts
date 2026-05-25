import { useAuthStore } from '../../store/authStore';
import { rewriteFrontendStoreKeys } from './rewriteFrontendStoreKeys';

/**
 * Legacy compatibility shim. The migration lifecycle now runs through
 * `useMigrationOrchestrator` + blocking gate.
 */
export async function migrateServerIndexKeysIfNeeded(): Promise<void> {
  await rewriteFrontendStoreKeys(useAuthStore.getState().servers);
}
