import { describe, expect, it } from 'vitest';
import type { SubsonicPlaylist } from '@/lib/api/subsonicTypes';
import {
  filterPlaylistsByNameQuery,
  isPlaylistsBrowsePath,
} from './playlistsBrowseSearch';

function pl(id: string, name: string): SubsonicPlaylist {
  return { id, name, songCount: 0, duration: 0, created: '', changed: '' };
}

describe('isPlaylistsBrowsePath', () => {
  it('matches only the playlists list route', () => {
    expect(isPlaylistsBrowsePath('/playlists')).toBe(true);
    expect(isPlaylistsBrowsePath('/playlists/abc')).toBe(false);
    expect(isPlaylistsBrowsePath('/artists')).toBe(false);
  });
});

describe('filterPlaylistsByNameQuery', () => {
  const list = [pl('1', 'Road Trip'), pl('2', 'Focus Mix'), pl('3', 'road house')];

  it('returns all playlists when query is empty', () => {
    expect(filterPlaylistsByNameQuery(list, '  ')).toEqual(list);
  });

  it('filters by case-insensitive name substring', () => {
    expect(filterPlaylistsByNameQuery(list, 'road').map(p => p.id)).toEqual(['1', '3']);
    expect(filterPlaylistsByNameQuery(list, 'FOCUS').map(p => p.id)).toEqual(['2']);
  });
});
