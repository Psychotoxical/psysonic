import { beforeEach, describe, expect, it, vi } from 'vitest';

const bindSession = vi.fn(async (_args: unknown) => undefined);
const queueInitial = vi.fn(async (_serverId: string) => undefined);
const syncContexts = vi.fn(async (_servers: unknown[]) => undefined);

vi.mock('@/lib/api/library', () => ({
  libraryGetStatus: vi.fn(),
  librarySyncBindSession: (args: unknown) => bindSession(args),
}));
vi.mock('./librarySyncQueue', () => ({
  enqueueLibrarySync: vi.fn(),
  queueInitialSyncIfNeeded: (serverId: string) => queueInitial(serverId),
}));
vi.mock('@/lib/server/serverEndpoint', () => ({
  ensureConnectUrlResolved: vi.fn(async (server: { url: string }) => ({ ok: true, baseUrl: server.url })),
}));
vi.mock('@/lib/server/syncServerHttpContext', () => ({
  syncAllServerHttpContexts: (servers: unknown[]) => syncContexts(servers),
  syncServerHttpContextForProfile: vi.fn(async () => undefined),
}));
vi.mock('@/lib/api/coverCache', () => ({
  libraryCoverBackfillRunFullPass: vi.fn(),
  libraryCoverClearFetchFailures: vi.fn(async () => 0),
}));
vi.mock('./libraryDevLog', () => ({
  libraryDevEnabled: () => false,
  logLibraryStatus: vi.fn(),
  logLibrarySync: vi.fn(),
  timed: vi.fn(),
}));

import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { bootstrapAllIndexedServers } from './librarySession';

describe('library session index ownership', () => {
  beforeEach(() => {
    bindSession.mockClear();
    queueInitial.mockClear();
    syncContexts.mockClear();
    useLibraryIndexStore.setState({ masterEnabled: true });
  });

  it.each(['primary', 'alias', null])('bootstraps the selected common-order owner when active is %s', async activeServerId => {
    const owner = {
      id: 'primary', name: 'Primary', url: 'https://same.test', username: 'owner', password: 'secret',
    };
    const alias = {
      ...owner, id: 'alias', name: 'Alias', url: 'http://same.test/',
    };
    useAuthStore.setState({
      servers: [owner, alias],
      activeServerId,
      musicLibraryServerIds: ['alias', 'primary'],
    });

    await expect(bootstrapAllIndexedServers()).resolves.toEqual({ 'same.test': 'bound' });
    expect(syncContexts).toHaveBeenCalledWith([owner]);
    expect(bindSession).toHaveBeenCalledTimes(1);
    expect(bindSession).toHaveBeenCalledWith({
      serverId: 'primary',
      baseUrl: 'https://same.test',
      username: 'owner',
      password: 'secret',
    });
    expect(queueInitial).toHaveBeenCalledWith('same.test');
  });
});
