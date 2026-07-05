import { describe, expect, it } from 'vitest';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import {
  albumBrowseCompFilterClientOnly,
  albumBrowseCompScanComplete,
  albumIsCompilation,
  albumIsCompilationFromTrackDtos,
  ALBUM_COMP_FILTER_MAX_SCAN_ALBUMS,
} from './albumCompilation';
import { filterAlbumsByCompilation } from './albumBrowseFilters';

const album = (
  overrides: Partial<SubsonicAlbum> & { compilation?: boolean; albumArtist?: string } = {},
): SubsonicAlbum => ({
  id: '1',
  name: 'A',
  artist: 'X',
  artistId: 'a',
  songCount: 1,
  duration: 1,
  ...overrides,
});

describe('albumIsCompilation', () => {
  it('reads isCompilation, compilation, releaseTypes, and VA artist', () => {
    expect(albumIsCompilation(album({ isCompilation: true }))).toBe(true);
    expect(albumIsCompilation(album({ compilation: true }))).toBe(true);
    expect(albumIsCompilation(album({ releaseTypes: ['Live', 'Compilation'] }))).toBe(true);
    expect(albumIsCompilation(album({ artist: 'Various Artists' }))).toBe(true);
    expect(albumIsCompilation(album({ albumArtist: 'Various Artists' }))).toBe(true);
    expect(albumIsCompilation(album())).toBe(false);
  });
});

describe('filterAlbumsByCompilation', () => {
  const albums = [
    album({ id: 'c', isCompilation: true }),
    album({ id: 'n' }),
  ];

  it('keeps only compilations', () => {
    expect(filterAlbumsByCompilation(albums, 'only').map(a => a.id)).toEqual(['c']);
  });

  it('hides compilations', () => {
    expect(filterAlbumsByCompilation(albums, 'hide').map(a => a.id)).toEqual(['n']);
  });
});

describe('albumBrowseCompScanComplete', () => {
  it('stops after scan budget when more pages exist', () => {
    const loaded = Array.from({ length: ALBUM_COMP_FILTER_MAX_SCAN_ALBUMS }, (_, i) =>
      album({ id: String(i) }),
    );
    expect(albumBrowseCompScanComplete(loaded, 'only', true)).toBe(true);
  });

  it('continues while under budget', () => {
    expect(albumBrowseCompScanComplete([album()], 'only', true)).toBe(false);
  });
});

describe('albumBrowseCompFilterClientOnly', () => {
  it('matches page mode only', () => {
    expect(albumBrowseCompFilterClientOnly('only', 'page')).toBe(true);
    expect(albumBrowseCompFilterClientOnly('only', 'slice')).toBe(false);
  });
});

describe('albumIsCompilationFromTrackDtos', () => {
  it('detects compilation flag in track rawJson', () => {
    expect(albumIsCompilationFromTrackDtos([{
      serverId: 's1',
      id: 't1',
      title: 'Hit',
      album: 'Comp Album',
      albumId: 'al1',
      durationSec: 1,
      syncedAt: 1,
      rawJson: { compilation: true },
    }])).toBe(true);
    expect(albumIsCompilationFromTrackDtos([{
      serverId: 's1',
      id: 't2',
      title: 'Song',
      album: 'Studio',
      albumId: 'al2',
      durationSec: 1,
      syncedAt: 1,
      rawJson: {},
    }])).toBe(false);
  });
});
