import { describe, expect, it } from 'vitest';
import { onInvoke } from '@/test/mocks/tauri';
import { runLocalLiveSearch } from './liveSearchLocal';

describe('runLocalLiveSearch', () => {
  it('returns null when live search invoke fails', async () => {
    onInvoke('library_live_search', () => {
      throw new Error('boom');
    });
    await expect(runLocalLiveSearch('s1', 'foo')).resolves.toBeNull();
  });

  it('maps live search rows to search3-shaped limits', async () => {
    onInvoke('library_live_search', () => ({
      artists: Array.from({ length: 8 }, (_, i) => ({
        serverId: 's1',
        id: `a${i}`,
        name: `Artist ${i}`,
        albumCount: 2,
        syncedAt: 1,
        rawJson: {},
      })),
      albums: Array.from({ length: 7 }, (_, i) => ({
        serverId: 's1',
        id: `al${i}`,
        name: `Album ${i}`,
        artist: 'A',
        artistId: 'a0',
        songCount: 1,
        durationSec: 100,
        syncedAt: 1,
        rawJson: {},
      })),
      tracks: Array.from({ length: 12 }, (_, i) => ({
        serverId: 's1',
        id: `t${i}`,
        title: `Track ${i}`,
        artist: 'A',
        album: 'Al',
        durationSec: 200,
        syncedAt: 1,
        rawJson: { id: `t${i}`, title: `Track ${i}`, artist: 'A', album: 'Al', albumId: 'al0', duration: 200 },
      })),
      source: 'local',
    }));

    const res = await runLocalLiveSearch('s1', 'foo');
    expect(res).not.toBeNull();
    expect(res!.artists).toHaveLength(5);
    expect(res!.albums).toHaveLength(5);
    expect(res!.songs).toHaveLength(10);
  });
});
