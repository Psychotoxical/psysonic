import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibrarySyncIdlePayload } from '@/lib/api/library/dto';
import { useAuthStore } from '@/store/authStore';

const syncIdleHandlerRef = vi.hoisted(() => ({
  current: null as ((payload: LibrarySyncIdlePayload) => void) | null,
}));

vi.mock('@/lib/api/library/events', () => ({
  subscribeLibrarySyncIdle: vi.fn(async (handler: (payload: LibrarySyncIdlePayload) => void) => {
    syncIdleHandlerRef.current = handler;
    return () => {
      syncIdleHandlerRef.current = null;
    };
  }),
}));

import {
  offlineLocalLibrarySyncRevision,
  resetOfflineLocalLibrarySyncRevisionForTests,
} from '@/store/offlineLocalLibrarySyncRevision';

describe('offlineLocalLibrarySyncRevision', () => {
  beforeEach(() => {
    useAuthStore.setState({
      activeServerId: 'srv-a',
      servers: [{ id: 'srv-a', name: 'A', url: 'https://a.test', username: 'u', password: 'p' }],
    });
    resetOfflineLocalLibrarySyncRevisionForTests();
    syncIdleHandlerRef.current = null;
  });

  it('bumps revision after successful sync-idle for index key and profile id', () => {
    expect(offlineLocalLibrarySyncRevision('srv-a')).toBe(0);
    syncIdleHandlerRef.current?.({
      serverId: 'a.test',
      libraryScope: 'default',
      kind: 'delta_sync',
      ok: true,
      error: null,
    });
    expect(offlineLocalLibrarySyncRevision('srv-a')).toBe(1);
    expect(offlineLocalLibrarySyncRevision('a.test')).toBe(1);
  });

  it('ignores failed sync-idle payloads', () => {
    syncIdleHandlerRef.current?.({
      serverId: 'a.test',
      libraryScope: 'default',
      kind: 'delta_sync',
      ok: false,
      error: 'fail',
    });
    expect(offlineLocalLibrarySyncRevision('srv-a')).toBe(0);
  });
});
