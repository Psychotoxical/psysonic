import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { useOfflineStore } from '@/features/offline/store/offlineStore';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import {
  entryNeedsFileRelocation,
  restoreOfflineLibraryPinSources,
} from '@/features/offline/utils/legacyOfflineFileMigration';
import type { LocalPlaybackEntry } from '@/store/localPlaybackStore';

function entry(overrides: Partial<LocalPlaybackEntry>): LocalPlaybackEntry {
  return {
    serverIndexKey: 'srv',
    trackId: 't1',
    localPath: '/old/path',
    layoutFingerprint: '',
    sizeBytes: 0,
    tier: 'library',
    cachedAt: 1,
    suffix: 'mp3',
    ...overrides,
  };
}

describe('entryNeedsFileRelocation', () => {
  it('detects psysonic-offline flat paths', () => {
    expect(entryNeedsFileRelocation(entry({
      localPath: '/home/u/.local/share/psysonic-offline/host/t1.mp3',
    }))).toBe(true);
  });

  it('skips paths already under media/library', () => {
    expect(entryNeedsFileRelocation(entry({
      localPath: '/home/u/.local/share/media/library/host/Artist/Album/01 - Song.mp3',
    }))).toBe(false);
  });

  it('skips ephemeral tier', () => {
    expect(entryNeedsFileRelocation(entry({
      tier: 'ephemeral',
      localPath: '/home/u/psysonic-offline/host/t1.mp3',
    }))).toBe(false);
  });
});

describe('restoreOfflineLibraryPinSources', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
    });
    useAuthStore.setState({
      servers: [{ id: 'srv-uuid', name: 'Home', url: 'http://music.test', username: 'u', password: 'p' }],
      activeServerId: 'srv-uuid',
    });
    useOfflineStore.setState({
      albums: {
        'music.test:al-1': {
          id: 'al-1',
          serverId: 'music.test',
          name: 'My Album',
          artist: 'Artist',
          trackIds: ['t1', 't2'],
          type: 'album',
        },
      },
    });
    useLocalPlaybackStore.setState({
      entries: {
        'music.test:t1': {
          serverIndexKey: 'music.test',
          trackId: 't1',
          localPath: '/media/library/music.test/Artist/My Album/01.mp3',
          layoutFingerprint: 'fp',
          sizeBytes: 100,
          tier: 'library',
          cachedAt: 1,
          suffix: 'mp3',
        },
      },
    });
  });

  it('attaches pinSource from offline albums for library entries', () => {
    expect(restoreOfflineLibraryPinSources()).toBe(1);
    const e = useLocalPlaybackStore.getState().entries['music.test:t1'];
    expect(e.pinSource).toEqual({ kind: 'album', sourceId: 'al-1', displayName: 'My Album' });
    expect(useLocalPlaybackStore.getState().listPinnedGroups()).toHaveLength(1);
  });
});
