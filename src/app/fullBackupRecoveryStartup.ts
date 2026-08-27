import { reconcileFullBackupImportRecovery } from '@/features/settings/utils/backup';
import type { WindowKind } from './windowKind';

/** Only the main webview may mutate durable full-import recovery state. */
export async function reconcileFullBackupImportRecoveryForWindow(
  windowKind: WindowKind,
): Promise<void> {
  if (windowKind !== 'main') return;
  await reconcileFullBackupImportRecovery();
}
