import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { emitTauriEvent, tauriMockListenerCount } from '@/test/mocks/tauri';
import { makeServer } from '@/test/helpers/factories';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { useAuthStore } from '@/store/authStore';
import { serverIndexKeyForProfile } from '@/lib/server/serverIndexKey';

vi.mock('@/utils/server/reconcileCanonicalEntityIds', () => ({
  reconcileCanonicalEntityIds: vi.fn().mockResolvedValue(undefined),
}));

import { reconcileCanonicalEntityIds } from '@/utils/server/reconcileCanonicalEntityIds';
import { useLibraryIdentityBridge } from './useLibraryIdentityBridge';

describe('useLibraryIdentityBridge', () => {
  beforeEach(() => {
    resetAuthStore();
    vi.mocked(reconcileCanonicalEntityIds).mockClear();
  });

  it('starts the blocking transition flow after a sync detects canonical IDs', async () => {
    const server = makeServer({ id: 'profile-1', url: 'https://music.test' });
    const serverIndexKey = serverIndexKeyForProfile(server);
    useAuthStore.setState({ servers: [server], activeServerId: server.id });
    renderHook(() => useLibraryIdentityBridge());
    await waitFor(() => expect(tauriMockListenerCount('library:sync-idle')).toBe(1));

    emitTauriEvent('library:sync-idle', {
      serverId: serverIndexKey,
      libraryScope: '',
      kind: 'delta_sync',
      ok: false,
      error: 'identity transition: canonical ID now resolves',
    });

    await waitFor(() => expect(reconcileCanonicalEntityIds).toHaveBeenCalledWith(
      server,
      serverIndexKey,
    ));
  });

  it('ignores unrelated sync failures', async () => {
    const server = makeServer({ id: 'profile-1', url: 'https://music.test' });
    useAuthStore.setState({ servers: [server], activeServerId: server.id });
    renderHook(() => useLibraryIdentityBridge());
    await waitFor(() => expect(tauriMockListenerCount('library:sync-idle')).toBe(1));

    emitTauriEvent('library:sync-idle', {
      serverId: serverIndexKeyForProfile(server),
      libraryScope: '',
      kind: 'delta_sync',
      ok: false,
      error: 'network timeout',
    });

    expect(reconcileCanonicalEntityIds).not.toHaveBeenCalled();
  });
});
