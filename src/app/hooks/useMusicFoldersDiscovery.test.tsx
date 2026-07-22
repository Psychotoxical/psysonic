import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { useMusicFoldersDiscovery } from './useMusicFoldersDiscovery';

const getMusicFoldersForServerMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api/subsonicLibrary', () => ({
  getMusicFoldersForServer: getMusicFoldersForServerMock,
}));

beforeEach(() => {
  resetAuthStore();
  getMusicFoldersForServerMock.mockReset().mockResolvedValue([
    { id: 'music', name: 'Music' },
  ]);
});

describe('useMusicFoldersDiscovery', () => {
  it('discovers folders for the active fallback when persisted membership is invalid', async () => {
    useAuthStore.setState({
      servers: [
        { id: 'first', name: 'First', url: 'https://first.test', username: 'u', password: 'p' },
        { id: 'active', name: 'Active', url: 'https://active.test', username: 'u', password: 'p' },
      ],
      activeServerId: 'active',
      libraryBrowseServerIds: ['missing'],
      isLoggedIn: true,
    });

    renderHook(() => useMusicFoldersDiscovery());

    await waitFor(() => expect(getMusicFoldersForServerMock).toHaveBeenCalledWith('active'));
    await waitFor(() => expect(useAuthStore.getState().musicFoldersByServer.active).toEqual([
      { id: 'music', name: 'Music' },
    ]));
    expect(getMusicFoldersForServerMock).toHaveBeenCalledTimes(1);
  });
});
