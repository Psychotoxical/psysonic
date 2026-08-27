import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError } from 'axios';
import { canonicalNavidromeId } from '@/lib/server/navidromeCanonicalId';
import {
  NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY,
  NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY,
} from '@/lib/server/navidromeCanonicalCheckpointStatus';

const { apiForServerMock, apiPostFormForServerMock, authState } = vi.hoisted(() => ({
  apiForServerMock: vi.fn(async (): Promise<unknown> => ({ status: 'ok' })),
  apiPostFormForServerMock: vi.fn(async () => ({ status: 'ok' })),
  authState: {
    openSubsonicExtensionsByServer: {} as Record<string, string[]>,
    servers: [] as Array<{ id: string; url: string }>,
  },
}));

vi.mock('@/lib/api/subsonicClient', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/subsonicClient')>('@/lib/api/subsonicClient');
  return {
    ...actual,
    api: vi.fn(),
    apiForServer: apiForServerMock,
    apiPostFormForServer: apiPostFormForServerMock,
  };
});

vi.mock('@/store/authStore', () => ({
  useAuthStore: {
    getState: () => authState,
  },
}));

import {
  fetchPlayQueueForServer,
  getPlayQueueForServer,
  savePlayQueue,
} from '@/lib/api/subsonicPlayQueue';

beforeEach(() => {
  apiForServerMock.mockReset();
  apiPostFormForServerMock.mockReset();
  apiForServerMock.mockResolvedValue({ status: 'ok' });
  apiPostFormForServerMock.mockResolvedValue({ status: 'ok' });
  authState.openSubsonicExtensionsByServer = {};
  authState.servers = [];
  localStorage.clear();
});

describe('savePlayQueue transport', () => {
  it('uses form POST when formPost is advertised', async () => {
    authState.openSubsonicExtensionsByServer = { 'srv-a': ['formPost', 'playbackReport'] };
    await savePlayQueue(['a', 'b'], 'a', 1000, 'srv-a');
    expect(apiPostFormForServerMock).toHaveBeenCalledWith('srv-a', 'savePlayQueue.view', {
      id: ['a', 'b'],
      current: 'a',
      position: 1000,
    });
    expect(apiForServerMock).not.toHaveBeenCalled();
  });

  it('uses GET when formPost is not advertised', async () => {
    authState.openSubsonicExtensionsByServer = { 'srv-a': ['playbackReport'] };
    await savePlayQueue(['a'], 'a', 0, 'srv-a');
    expect(apiForServerMock).toHaveBeenCalledWith('srv-a', 'savePlayQueue.view', {
      id: ['a'],
      current: 'a',
      position: 0,
    });
    expect(apiPostFormForServerMock).not.toHaveBeenCalled();
  });

  it('retries once as POST after HTTP 414 on GET', async () => {
    const err = new AxiosError('Request failed');
    err.response = { status: 414, data: '', statusText: 'URI Too Long', headers: {}, config: {} as never };
    apiForServerMock.mockRejectedValueOnce(err);

    await savePlayQueue(['a', 'b'], 'a', 50, 'srv-a');

    expect(apiForServerMock).toHaveBeenCalledTimes(1);
    expect(apiPostFormForServerMock).toHaveBeenCalledWith('srv-a', 'savePlayQueue.view', {
      id: ['a', 'b'],
      current: 'a',
      position: 50,
    });
  });

  it('does not retry POST on non-414 GET failures', async () => {
    apiForServerMock.mockRejectedValueOnce(new Error('offline'));
    await expect(savePlayQueue(['a'], 'a', 0, 'srv-a')).rejects.toThrow('offline');
    expect(apiPostFormForServerMock).not.toHaveBeenCalled();
  });

  it('refuses delayed queue writes while canonical migration is active', async () => {
    localStorage.setItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY, '1');
    await expect(savePlayQueue(['a'], 'a', 0, 'srv-a')).rejects.toThrow('canonical_migration_active');
    expect(apiForServerMock).not.toHaveBeenCalled();
    expect(apiPostFormForServerMock).not.toHaveBeenCalled();
  });

  it('allows a queue write for an owner outside a scoped runtime migration', async () => {
    localStorage.setItem(
      NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY,
      `runtime:${encodeURIComponent('srv-b')}:token`,
    );

    await expect(savePlayQueue(['a'], 'a', 0, 'srv-a')).resolves.toBeUndefined();
    expect(apiForServerMock).toHaveBeenCalledWith('srv-a', 'savePlayQueue.view', {
      id: ['a'],
      current: 'a',
      position: 0,
    });
  });

  it('blocks a queue write for the owner under a scoped runtime migration', async () => {
    localStorage.setItem(
      NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY,
      `runtime:${encodeURIComponent('srv-a')}:token`,
    );

    await expect(savePlayQueue(['a'], 'a', 0, 'srv-a'))
      .rejects.toThrow('canonical_migration_active');
    expect(apiForServerMock).not.toHaveBeenCalled();
  });

  it('resolves a profile UUID before checking a scoped runtime migration', async () => {
    const profileId = '123e4567-e89b-42d3-a456-426614174000';
    authState.servers = [{ id: profileId, url: 'https://music.test' }];
    localStorage.setItem(
      NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY,
      `runtime:${encodeURIComponent('music.test')}:token`,
    );

    await expect(savePlayQueue(['a'], 'a', 0, profileId))
      .rejects.toThrow('canonical_migration_active');
    expect(apiForServerMock).not.toHaveBeenCalled();
  });

  it('fails closed for an unknown profile UUID while a scoped migration is active', async () => {
    localStorage.setItem(
      NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY,
      `runtime:${encodeURIComponent('music.test')}:token`,
    );

    await expect(savePlayQueue(
      ['a'],
      'a',
      0,
      '123e4567-e89b-42d3-a456-426614174000',
    )).rejects.toThrow('canonical_migration_active');
    expect(apiForServerMock).not.toHaveBeenCalled();
  });

  it('fails closed for a malformed scoped runtime lock', async () => {
    localStorage.setItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY, 'runtime:srv-a');
    await expect(savePlayQueue(['a'], 'a', 0, 'srv-b'))
      .rejects.toThrow('canonical_migration_active');
    expect(apiForServerMock).not.toHaveBeenCalled();
  });
});

describe('play queue reads', () => {
  it('strict fetch returns a parsed server queue', async () => {
    apiForServerMock.mockResolvedValueOnce({
      playQueue: { current: 'b', position: 1200, entry: [{ id: 'a' }, { id: 'b' }] },
    });
    await expect(fetchPlayQueueForServer('srv-a')).resolves.toEqual({
      current: 'b',
      position: 1200,
      songs: [{ id: 'a' }, { id: 'b' }],
    });
  });

  it('strict fetch propagates failure while the compatibility wrapper returns empty', async () => {
    apiForServerMock.mockRejectedValueOnce(new Error('offline'));
    await expect(fetchPlayQueueForServer('srv-a')).rejects.toThrow('offline');
    apiForServerMock.mockRejectedValueOnce(new Error('offline'));
    await expect(getPlayQueueForServer('srv-a')).resolves.toEqual({ songs: [] });
  });

  it('normalizes a stale remote queue after the owner reaches ready', async () => {
    const profileId = '123e4567-e89b-42d3-a456-426614174000';
    const legacyId = '550e8400-e29b-41d4-a716-446655440000';
    localStorage.setItem('psysonic-auth', JSON.stringify({
      state: { servers: [{ id: profileId, url: 'https://music.test' }] },
    }));
    localStorage.setItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY, JSON.stringify({
      version: 1,
      servers: {
        'music.test': { canonicalVersion: 1, phase: 'ready', checkedVersion: '0.64.0' },
      },
    }));
    apiForServerMock.mockResolvedValueOnce({
      playQueue: {
        current: legacyId,
        entry: [{
          id: legacyId,
          title: 'Track',
          artist: 'Artist',
          album: 'Album',
          albumId: legacyId,
          duration: 10,
        }],
      },
    });

    const queue = await fetchPlayQueueForServer(profileId);
    const canonical = canonicalNavidromeId(legacyId);
    expect(queue.current).toBe(canonical);
    expect(queue.songs[0]).toMatchObject({ id: canonical, albumId: canonical });
  });
});
