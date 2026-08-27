import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { useMusicFoldersDiscovery } from './useMusicFoldersDiscovery';
import { canonicalNavidromeId } from '@/lib/server/navidromeCanonicalId';
import { NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY } from '@/lib/server/navidromeCanonicalCheckpointStatus';

const getMusicFoldersForServerMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api/subsonicLibrary', () => ({
  getMusicFoldersForServer: getMusicFoldersForServerMock,
}));

beforeEach(() => {
  localStorage.clear();
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

  it('canonicalizes and deduplicates folders from a canonical Navidrome profile', async () => {
    const legacyId = '123e4567-e89b-12d3-a456-426614174000';
    const canonicalId = canonicalNavidromeId(legacyId);
    useAuthStore.setState({
      servers: [
        { id: 'active', name: 'Active', url: 'https://active.test', username: 'u', password: 'p' },
      ],
      activeServerId: 'active',
      libraryBrowseServerIds: ['active'],
      subsonicServerIdentityByServer: {
        active: { type: 'navidrome', serverVersion: '0.63.2' },
      },
      libraryBrowseSelectionByServer: { active: [canonicalId] },
      isLoggedIn: true,
    });
    localStorage.setItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY, JSON.stringify({
      version: 1,
      servers: {
        'active.test': {
          canonicalVersion: 1,
          phase: 'ready',
          checkedVersion: '0.64.0',
        },
      },
    }));
    getMusicFoldersForServerMock.mockResolvedValue([
      { id: legacyId, name: 'Music' },
      { id: canonicalId, name: '' },
    ]);

    renderHook(() => useMusicFoldersDiscovery());

    await waitFor(() => expect(useAuthStore.getState().musicFoldersByServer.active).toEqual([
      { id: canonicalId, name: 'Music' },
    ]));
    expect(useAuthStore.getState().libraryBrowseSelectionByServer.active).toEqual([canonicalId]);
  });
});
