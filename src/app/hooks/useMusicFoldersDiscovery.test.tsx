import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { useMusicFoldersDiscovery } from './useMusicFoldersDiscovery';
import {
  activateCanonicalNavidromeOwners,
  canonicalizeNavidromeId,
  deactivateCanonicalNavidromeOwners,
} from '@/lib/server/navidromeCanonicalIds';

const getMusicFoldersForServerMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api/subsonicLibrary', () => ({
  getMusicFoldersForServer: getMusicFoldersForServerMock,
}));

beforeEach(() => {
  deactivateCanonicalNavidromeOwners(['active', 'active.test']);
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

  it('canonicalizes a folder response that started before canonical ACK without losing selection', async () => {
    const legacyFolderId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const canonicalFolderId = canonicalizeNavidromeId(legacyFolderId);
    let resolveFolders!: (folders: Array<{ id: string; name: string }>) => void;
    getMusicFoldersForServerMock.mockImplementation(() => new Promise(resolve => {
      resolveFolders = resolve;
    }));
    useAuthStore.setState({
      servers: [
        { id: 'active', name: 'Active', url: 'https://active.test', username: 'u', password: 'p' },
      ],
      activeServerId: 'active',
      libraryBrowseServerIds: ['active'],
      libraryBrowseSelectionByServer: { active: [canonicalFolderId] },
      isLoggedIn: true,
    });

    renderHook(() => useMusicFoldersDiscovery());
    await waitFor(() => expect(getMusicFoldersForServerMock).toHaveBeenCalledWith('active'));

    activateCanonicalNavidromeOwners(['active', 'active.test']);
    resolveFolders([{ id: legacyFolderId, name: 'Music' }]);

    await waitFor(() => expect(useAuthStore.getState().musicFoldersByServer.active).toEqual([
      { id: canonicalFolderId, name: 'Music' },
    ]));
    expect(useAuthStore.getState().libraryBrowseSelectionByServer.active).toEqual([canonicalFolderId]);
    deactivateCanonicalNavidromeOwners(['active', 'active.test']);
  });
});
