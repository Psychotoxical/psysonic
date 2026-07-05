import { describe, it, expect } from 'vitest';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import {
  getDisplayedSongs,
  type DisplayedSongsOptions,
  type PlaylistSortKey,
  type PlaylistSortDir,
} from '@/features/playlist/utils/playlistDisplayedSongs';

const song = (id: string, title = id, artist = ''): SubsonicSong =>
  ({ id, title, artist }) as SubsonicSong;

const opts = (over: Partial<DisplayedSongsOptions> = {}): DisplayedSongsOptions => ({
  filterText: '',
  sortKey: 'natural',
  sortDir: 'asc',
  ratings: {},
  userRatingOverrides: {},
  starredOverrides: {},
  starredSongs: new Set<string>(),
  ...over,
});

const ids = (songs: SubsonicSong[]) => songs.map(s => s.id);

describe('getDisplayedSongs — position (date added)', () => {
  // Playlist load order is oldest→newest (servers append new tracks at the end).
  const list = [song('a'), song('b'), song('c'), song('d')];

  it('ascending keeps the playlist load order (oldest → newest)', () => {
    expect(ids(getDisplayedSongs(list, opts({ sortKey: 'position', sortDir: 'asc' })))).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('descending reverses it (newest added first) — the requested behaviour', () => {
    expect(ids(getDisplayedSongs(list, opts({ sortKey: 'position', sortDir: 'desc' })))).toEqual([
      'd',
      'c',
      'b',
      'a',
    ]);
  });

  it('never mutates the input array', () => {
    const input = [song('a'), song('b'), song('c')];
    getDisplayedSongs(input, opts({ sortKey: 'position', sortDir: 'desc' }));
    expect(ids(input)).toEqual(['a', 'b', 'c']);
  });

  it('filters first, then reverses the surviving rows', () => {
    const mixed = [song('1', 'alpha'), song('2', 'beta'), song('3', 'alphabet')];
    const out = getDisplayedSongs(
      mixed,
      opts({ sortKey: 'position', sortDir: 'desc', filterText: 'alpha' }),
    );
    expect(ids(out)).toEqual(['3', '1']);
  });

  it("natural still ignores sortDir (it is the reset state, not a position sort)", () => {
    const k: PlaylistSortKey = 'natural';
    const d: PlaylistSortDir = 'desc';
    expect(ids(getDisplayedSongs(list, opts({ sortKey: k, sortDir: d })))).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });
});
