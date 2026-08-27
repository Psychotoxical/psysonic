import { beforeEach, describe, expect, it, vi } from 'vitest';

const reconcileFullBackupImportRecovery = vi.hoisted(() => vi.fn());

vi.mock('@/features/settings/utils/backup', () => ({
  reconcileFullBackupImportRecovery,
}));

import { reconcileFullBackupImportRecoveryForWindow } from './fullBackupRecoveryStartup';

beforeEach(() => reconcileFullBackupImportRecovery.mockReset());

describe('full backup recovery startup ownership', () => {
  it('runs durable reconciliation only in the main webview', async () => {
    await reconcileFullBackupImportRecoveryForWindow('mini');
    expect(reconcileFullBackupImportRecovery).not.toHaveBeenCalled();

    await reconcileFullBackupImportRecoveryForWindow('main');
    expect(reconcileFullBackupImportRecovery).toHaveBeenCalledOnce();
  });
});
