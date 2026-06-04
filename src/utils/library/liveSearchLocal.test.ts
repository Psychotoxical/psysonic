import { describe, expect, it } from 'vitest';
import { onInvoke } from '@/test/mocks/tauri';
import type { SearchResults } from '../../api/subsonicTypes';
import { useAuthStore } from '@/store/authStore';
import {
  liveSearchQueryRejected,
  liveSearchQueryTooShort,
  mergeLiveSearchResults,
  runLocalLiveSearch,
} from './liveSearchLocal';

const neverStale = { epoch: 1, isStale: () => false };
const alwaysStale = { epoch: 1, isStale: () => true };

describe('runLocalLiveSearch', () => {
  it('returns null without invoking for a single-character query', async () => {
    let invoked = false;
    onInvoke('library_live_search', () => {
      invoked = true;
      return { artists: [], albums: [], tracks: [], source: 'local' };
    });
    await expect(runLocalLiveSearch('s1', 'а', neverStale)).resolves.toBeNull();
    expect(invoked).toBe(false);
  });

  it('returns null when stale before invoke completes', async () => {
    onInvoke('library_live_search', () => ({
      artists: [],
      albums: [],
      tracks: [{ serverId: 's1', id: 't1', title: 'T', album: 'A', durationSec: 1, syncedAt: 0 }],
      source: 'local',
    }));
    await expect(runLocalLiveSearch('s1', 'foo', alwaysStale)).resolves.toBeNull();
  });

  it('returns null when live search invoke fails', async () => {
    onInvoke('library_live_search', () => {
      throw new Error('boom');
    });
    await expect(runLocalLiveSearch('s1', 'foo', neverStale)).resolves.toBeNull();
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

    const res = await runLocalLiveSearch('s1', 'foo', neverStale);
    expect(res).not.toBeNull();
    expect(res!.artists).toHaveLength(5);
    expect(res!.albums).toHaveLength(5);
    expect(res!.songs).toHaveLength(10);
  });

  it('passes libraryScope from the sidebar music library filter', async () => {
    useAuthStore.setState({ musicLibraryFilterByServer: { s1: 'lib7' } });
    let captured: unknown;
    onInvoke('library_live_search', (args) => {
      captured = args;
      return { artists: [], albums: [], tracks: [], source: 'local' };
    });
    await runLocalLiveSearch('s1', 'foo', neverStale);
    expect(captured).toMatchObject({ request: { serverId: 's1', libraryScope: 'lib7' } });
  });
});

describe('liveSearchQueryRejected', () => {
  it('rejects syntax junk and single-character queries', () => {
    expect(liveSearchQueryRejected('**')).toBe(true);
    expect(liveSearchQueryRejected('1=2')).toBe(true);
    expect(liveSearchQueryRejected('а')).toBe(true);
    expect(liveSearchQueryRejected('ab')).toBe(false);
    expect(liveSearchQueryRejected('metallica')).toBe(false);
  });
});

describe('liveSearchQueryTooShort', () => {
  it('treats one grapheme as too short', () => {
    expect(liveSearchQueryTooShort('а')).toBe(true);
    expect(liveSearchQueryTooShort('ab')).toBe(false);
  });
});

describe('mergeLiveSearchResults', () => {
  it('keeps local order and fills gaps from network', () => {
    const local: SearchResults = {
      artists: [{ id: 'a1', name: 'Local' }],
      albums: [],
      songs: [{ id: 's1', title: 'Song', artist: 'A', album: 'Al', albumId: 'al0', duration: 1 }],
    };
    const network: SearchResults = {
      artists: [{ id: 'a2', name: 'Net' }],
      albums: [{ id: 'al1', name: 'Album', artist: 'A', artistId: 'a2', songCount: 1, duration: 100 }],
      songs: [{ id: 's2', title: 'Other', artist: 'B', album: 'Bl', albumId: 'al1', duration: 2 }],
    };
    const merged = mergeLiveSearchResults(local, network);
    expect(merged.artists.map(a => a.id)).toEqual(['a1', 'a2']);
    expect(merged.albums.map(a => a.id)).toEqual(['al1']);
    expect(merged.songs.map(s => s.id)).toEqual(['s1', 's2']);
  });
});
