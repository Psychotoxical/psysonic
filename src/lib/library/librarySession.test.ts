import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emitTauriEvent, onInvoke } from '@/test/mocks/tauri';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import type { ServerProfile } from '@/store/authStoreTypes';

const sessionMocks = vi.hoisted(() => ({
  ensureConnectUrlResolved: vi.fn(),
  syncServerHttpContextForProfile: vi.fn(async () => undefined),
  syncAllServerHttpContexts: vi.fn(),
  libraryCoverClearFetchFailures: vi.fn(),
  libraryCoverBackfillRunFullPass: vi.fn(),
}));

vi.mock('@/lib/server/serverEndpoint', () => ({
  ensureConnectUrlResolved: sessionMocks.ensureConnectUrlResolved,
}));

vi.mock('@/lib/server/syncServerHttpContext', () => ({
  setServerHttpContextIdentitySource: vi.fn(),
  syncServerHttpContextForProfile: sessionMocks.syncServerHttpContextForProfile,
  syncAllServerHttpContexts: sessionMocks.syncAllServerHttpContexts,
}));

vi.mock('@/lib/api/coverCache', () => ({
  libraryCoverClearFetchFailures: sessionMocks.libraryCoverClearFetchFailures,
  libraryCoverBackfillRunFullPass: sessionMocks.libraryCoverBackfillRunFullPass,
}));

import {
  bootstrapIndexedServer,
  resetLibrarySessionForTests,
  resumeInitialSyncIfIncomplete,
} from './librarySession';
import { enqueueLibrarySync, resetLibrarySyncQueueForTests } from './librarySyncQueue';

const server: ServerProfile = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Music',
  url: 'https://music.test/rest',
  username: 'user',
  password: 'password',
};

const status = (over: Record<string, unknown> = {}) => ({
  serverId: 's1',
  libraryScope: '',
  syncPhase: 'idle',
  capabilityFlags: 0,
  libraryTier: 'unknown',
  syncedAt: 0,
  ...over,
});

function mockQueuedStart() {
  const start = vi.fn(async (args: unknown) => {
    const { serverId } = args as { serverId: string };
    queueMicrotask(() =>
      emitTauriEvent('library:sync-idle', {
        serverId,
        libraryScope: '',
        kind: 'initial_sync',
        jobId: 'j1',
        ok: true,
      }),
    );
    return { jobId: 'j1', serverId, kind: 'initial_sync' };
  });
  onInvoke('library_sync_start', start);
  return start;
}

describe('resumeInitialSyncIfIncomplete', () => {
  beforeEach(() => {
    resetAuthStore();
    resetLibrarySyncQueueForTests();
    resetLibrarySessionForTests();
    useLibraryIndexStore.setState({ masterEnabled: true });
    useAuthStore.setState({ servers: [server], activeServerId: server.id });
    sessionMocks.ensureConnectUrlResolved.mockReset().mockResolvedValue({
      ok: true,
      baseUrl: server.url,
      endpoint: { url: server.url, kind: 'public' },
      ping: { ok: true },
    });
    sessionMocks.syncServerHttpContextForProfile.mockReset().mockResolvedValue(undefined);
    sessionMocks.syncAllServerHttpContexts.mockReset().mockResolvedValue(undefined);
    sessionMocks.libraryCoverClearFetchFailures.mockReset().mockResolvedValue(0);
    sessionMocks.libraryCoverBackfillRunFullPass.mockReset().mockResolvedValue(undefined);
  });

  it('single-flights concurrent URL-key bootstraps and resumes the stranded sync once', async () => {
    const duplicateProfile = {
      ...server,
      id: '22222222-2222-4222-8222-222222222222',
    };
    useAuthStore.setState({ servers: [server, duplicateProfile] });
    let releaseBind!: () => void;
    const bindGate = new Promise<void>(resolve => { releaseBind = resolve; });
    const bind = vi.fn(async () => { await bindGate; });
    onInvoke('library_sync_bind_session', bind);
    onInvoke('library_get_status', () => status({ syncPhase: 'initial_sync' }));
    const start = mockQueuedStart();

    const first = bootstrapIndexedServer(server);
    const second = bootstrapIndexedServer(duplicateProfile);
    await vi.waitFor(() => expect(bind).toHaveBeenCalledTimes(1));
    releaseBind();

    await expect(Promise.all([first, second])).resolves.toEqual(['bound', 'bound']);
    expect(bind).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'music.test/rest',
      baseUrl: server.url,
    }));
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'music.test/rest',
      mode: 'full',
    }));
  });

  it('replays the shared bind with credentials edited while it is in flight', async () => {
    let releaseFirstBind!: () => void;
    const firstBindGate = new Promise<void>(resolve => { releaseFirstBind = resolve; });
    const passwords: string[] = [];
    const bind = vi.fn(async (args: unknown) => {
      const { password } = args as { password: string };
      passwords.push(password);
      if (password === server.password) await firstBindGate;
    });
    onInvoke('library_sync_bind_session', bind);
    onInvoke('library_get_status', () => status({ syncPhase: 'ready', lastFullSyncAt: 1 }));

    const first = bootstrapIndexedServer(server);
    await vi.waitFor(() => expect(bind).toHaveBeenCalledTimes(1));
    const editedServer = { ...server, password: 'new-password' };
    useAuthStore.setState({ servers: [editedServer] });
    const second = bootstrapIndexedServer(editedServer);
    releaseFirstBind();

    await expect(Promise.all([first, second])).resolves.toEqual(['error', 'bound']);
    expect(passwords).toEqual(['password', 'new-password']);
  });

  it('resumes when initial sync was interrupted mid-run', async () => {
    onInvoke('library_get_status', () => status({ syncPhase: 'initial_sync' }));
    const start = mockQueuedStart();

    await resumeInitialSyncIfIncomplete('s1');

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: 's1', mode: 'full' }),
    );
  });

  it('does not restart when idle with a completed index (legacy missing lastFullSyncAt)', async () => {
    onInvoke('library_get_status', () =>
      status({ syncPhase: 'idle', localTrackCount: 12_000 }),
    );
    const start = vi.fn();
    onInvoke('library_sync_start', start);

    await resumeInitialSyncIfIncomplete('s1');

    expect(start).not.toHaveBeenCalled();
  });

  it('does nothing when a full sync has already completed', async () => {
    onInvoke('library_get_status', () => status({ syncPhase: 'ready', lastFullSyncAt: 1_716_000_000_000 }));
    const start = vi.fn();
    onInvoke('library_sync_start', start);

    await resumeInitialSyncIfIncomplete('s1');

    expect(start).not.toHaveBeenCalled();
  });

  it('de-dupes concurrent calls so a second start cannot cancel the first', async () => {
    onInvoke('library_get_status', () => status({ syncPhase: 'initial_sync' }));
    const start = mockQueuedStart();

    await Promise.all([
      resumeInitialSyncIfIncomplete('s1'),
      resumeInitialSyncIfIncomplete('s1'),
    ]);

    expect(start).toHaveBeenCalledTimes(1);
  });

  it('does not replace a genuinely active queued native sync', async () => {
    onInvoke('library_get_status', () => status({ syncPhase: 'initial_sync' }));
    const start = vi.fn(async (args: unknown) => {
      const { serverId } = args as { serverId: string };
      return { jobId: 'j-active', serverId, kind: 'initial_sync' };
    });
    onInvoke('library_sync_start', start);
    const active = enqueueLibrarySync({ serverId: 's1', kind: 'full' });
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));

    await resumeInitialSyncIfIncomplete('s1');

    expect(start).toHaveBeenCalledTimes(1);
    emitTauriEvent('library:sync-idle', {
      serverId: 's1',
      libraryScope: '',
      kind: 'initial_sync',
      jobId: 'j-active',
      ok: true,
    });
    await active;
  });

  it('stays silent when the status lookup fails', async () => {
    onInvoke('library_get_status', () => { throw new Error('boom'); });
    const start = vi.fn();
    onInvoke('library_sync_start', start);

    await expect(resumeInitialSyncIfIncomplete('s1')).resolves.toBeUndefined();
    expect(start).not.toHaveBeenCalled();
  });
});
