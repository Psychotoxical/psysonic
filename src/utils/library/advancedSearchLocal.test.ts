import { describe, it, expect, beforeEach } from 'vitest';
import { onInvoke } from '@/test/mocks/tauri';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { runLocalAdvancedSearch, runLocalSongBrowse } from './advancedSearchLocal';

const opts = (over: Partial<Parameters<typeof runLocalAdvancedSearch>[1]> = {}) => ({
  query: '',
  genre: '',
  yearFrom: '',
  yearTo: '',
  resultType: 'all' as const,
  ...over,
});

const ready = () =>
  onInvoke('library_get_status', () => ({
    serverId: 's1',
    libraryScope: '',
    syncPhase: 'ready',
    capabilityFlags: 0,
    libraryTier: 'unknown',
    syncedAt: 0,
  }));

describe('runLocalAdvancedSearch', () => {
  beforeEach(() => {
    useLibraryIndexStore.getState().setIndexEnabled('s1', true);
  });

  it('returns null (→ network fallback) when the index is not ready', async () => {
    onInvoke('library_get_status', () => ({ serverId: 's1', libraryScope: '', syncPhase: 'initial_sync' }));
    const res = await runLocalAdvancedSearch('s1', opts({ query: 'x' }), 100);
    expect(res).toBeNull();
  });

  it('returns null when the index is disabled for the server', async () => {
    useLibraryIndexStore.getState().setIndexEnabled('s1', false);
    const res = await runLocalAdvancedSearch('s1', opts({ query: 'x' }), 100);
    expect(res).toBeNull();
  });

  it('passes libraryScope from the sidebar music library filter', async () => {
    useAuthStore.setState({ musicLibraryFilterByServer: { s1: 'lib7' } });
    ready();
    let captured: unknown;
    onInvoke('library_advanced_search', (args) => {
      captured = args;
      return {
        artists: [],
        albums: [],
        tracks: [],
        totals: { artists: 0, albums: 0, tracks: 0 },
        source: 'local',
      };
    });
    await runLocalAdvancedSearch('s1', opts({ query: 'x' }), 100);
    expect(captured).toMatchObject({ request: { libraryScope: 'lib7' } });
  });

  it('prefers rawJson, falls back to hot columns, and reports the full total', async () => {
    ready();
    onInvoke('library_advanced_search', () => ({
      artists: [],
      albums: [],
      tracks: [
        {
          serverId: 's1', id: 't1', title: 'Hot Title', album: 'Alb', albumId: 'al1',
          durationSec: 100, syncedAt: 0,
          // rawJson is the authoritative original song — must win.
          rawJson: {
            id: 't1', title: 'Raw Title', artist: 'Raw Artist', album: 'Alb', albumId: 'al1',
            duration: 100, contributors: [{ role: 'composer', artist: { name: 'C' } }],
          },
        },
        {
          serverId: 's1', id: 't2', title: 'Only Hot', album: 'Alb2', albumId: 'al2',
          artist: 'Hot Artist', durationSec: 200, year: 1999, genre: 'Rock',
          starredAt: 1_700_000_000_000, syncedAt: 0,
          rawJson: {}, // sparse → hot-column fallback
        },
      ],
      totals: { artists: 0, albums: 0, tracks: 42 },
      appliedFilters: [],
      source: 'local',
    }));

    const res = await runLocalAdvancedSearch('s1', opts({ resultType: 'songs' }), 100);
    expect(res).not.toBeNull();
    expect(res!.songs).toHaveLength(2);

    // rawJson wins where present + carries OpenSubsonic extras.
    expect(res!.songs[0].title).toBe('Raw Title');
    expect(res!.songs[0].artist).toBe('Raw Artist');
    expect(res!.songs[0].contributors).toBeDefined();

    // hot-column fallback when rawJson is sparse.
    expect(res!.songs[1].title).toBe('Only Hot');
    expect(res!.songs[1].artist).toBe('Hot Artist');
    expect(res!.songs[1].year).toBe(1999);
    expect(res!.songs[1].genre).toBe('Rock');
    expect(res!.songs[1].starred).toBeTruthy();

    // Total is the full match count, not the page size.
    expect(res!.songsTotal).toBe(42);
  });

  it('returns null without throwing when the local query errors', async () => {
    ready();
    onInvoke('library_advanced_search', () => {
      throw new Error('boom');
    });
    const res = await runLocalAdvancedSearch('s1', opts({ query: 'x' }), 100);
    expect(res).toBeNull();
  });
});

describe('runLocalSongBrowse', () => {
  beforeEach(() => {
    useLibraryIndexStore.getState().setIndexEnabled('s1', true);
  });

  it('returns null for a missing server id (→ network browse)', async () => {
    expect(await runLocalSongBrowse(null, 0, 50)).toBeNull();
  });

  it('returns null (→ network browse) when the index is not ready', async () => {
    onInvoke('library_get_status', () => ({ serverId: 's1', libraryScope: '', syncPhase: 'initial_sync' }));
    expect(await runLocalSongBrowse('s1', 0, 50)).toBeNull();
  });

  it('returns null when the response is not local', async () => {
    ready();
    onInvoke('library_advanced_search', () => ({
      artists: [], albums: [], tracks: [],
      totals: { artists: 0, albums: 0, tracks: 0 }, appliedFilters: [], source: 'network',
    }));
    expect(await runLocalSongBrowse('s1', 0, 50)).toBeNull();
  });

  it('maps the local browse page to Subsonic songs (rawJson wins)', async () => {
    ready();
    onInvoke('library_advanced_search', () => ({
      artists: [],
      albums: [],
      tracks: [
        {
          serverId: 's1', id: 't1', title: 'Hot', album: 'Alb', albumId: 'al1',
          durationSec: 100, syncedAt: 0,
          rawJson: { id: 't1', title: 'Raw', artist: 'Raw Artist', album: 'Alb', albumId: 'al1', duration: 100 },
        },
      ],
      totals: { artists: 0, albums: 0, tracks: 1 }, appliedFilters: [], source: 'local',
    }));
    const songs = await runLocalSongBrowse('s1', 0, 50);
    expect(songs).not.toBeNull();
    expect(songs!).toHaveLength(1);
    expect(songs![0].title).toBe('Raw');
    expect(songs![0].artist).toBe('Raw Artist');
  });

  it('returns null without throwing on error', async () => {
    ready();
    onInvoke('library_advanced_search', () => {
      throw new Error('boom');
    });
    expect(await runLocalSongBrowse('s1', 0, 50)).toBeNull();
  });
});
