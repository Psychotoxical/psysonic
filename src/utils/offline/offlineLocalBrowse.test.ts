import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../store/authStore';
import { useLibraryIndexStore } from '../../store/libraryIndexStore';
import { useLocalPlaybackStore } from '../../store/localPlaybackStore';
import {
  countLocalBrowsableTracks,
  offlineLocalBrowseEnabled,
} from './offlineLocalBrowse';

vi.mock('../../api/library', () => ({
  libraryGetTracksBatchChunked: vi.fn(async () => []),
  libraryGetTracksByAlbum: vi.fn(async () => []),
  libraryAdvancedSearch: vi.fn(async () => ({ albums: [], artists: [], tracks: [] })),
}));

describe('offlineLocalBrowse', () => {
  beforeEach(() => {
    useAuthStore.setState({
      activeServerId: 'srv-a',
      servers: [{ id: 'srv-a', name: 'A', url: 'https://a.test', username: 'u', password: 'p' }],
    });
    useLibraryIndexStore.setState({ masterEnabled: true });
    useLocalPlaybackStore.setState({ entries: {} });
  });

  it('offlineLocalBrowseEnabled requires index and local bytes', () => {
    expect(offlineLocalBrowseEnabled('srv-a')).toBe(false);
    useLocalPlaybackStore.setState({
      entries: {
        'a.test:t1': {
          serverIndexKey: 'a.test',
          trackId: 't1',
          localPath: '/media/library/a.test/a/al/t1.mp3',
          layoutFingerprint: 'fp',
          sizeBytes: 1,
          tier: 'library',
          cachedAt: 1,
          suffix: 'mp3',
        },
      },
    });
    expect(countLocalBrowsableTracks('srv-a')).toBe(1);
    expect(offlineLocalBrowseEnabled('srv-a')).toBe(true);
  });
});
