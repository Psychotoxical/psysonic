import { describe, expect, it } from 'vitest';
import type { SubsonicAlbum, SubsonicArtist, SubsonicPlaylist } from '@/lib/api/subsonicTypes';
import {
  benchmarkRouteMatchesLocation,
  benchmarkSearchQueryFromCandidates,
  benchmarkStaticRoutesForScenario,
  buildDynamicBenchmarkRoutes,
} from './benchmarkRoutes';

describe('benchmark routes', () => {
  it('includes every distinct static page in all-pages', () => {
    expect(benchmarkStaticRoutesForScenario('all-pages')).toEqual(expect.arrayContaining([
      '/random',
      '/random/albums',
      '/random/mix',
      '/search',
      '/search/advanced',
      '/player-stats',
      '/now-playing',
      '/device-sync',
    ]));
  });

  it('builds owner-qualified detail routes and encodes names', () => {
    const albums = [{
      id: 'album-1',
      serverId: 'srv-1',
      name: 'Album',
      artist: 'Artist',
      songCount: 1,
      duration: 1,
      recordLabel: 'A & B',
      genre: 'Rock & Roll',
    }] as SubsonicAlbum[];
    const artists = [{ id: 'artist-1', serverId: 'srv-1', name: 'Artist' }] as SubsonicArtist[];
    const composers = [{ id: 'composer-1', serverId: 'srv-1', name: 'Composer' }] as SubsonicArtist[];
    const playlists = [{ id: 'playlist-1', serverId: 'srv-1', name: 'Playlist' }] as SubsonicPlaylist[];

    const result = buildDynamicBenchmarkRoutes({
      albums,
      artists,
      composers,
      playlists,
      activeServerId: 'srv-1',
      configuredServerIds: new Set(['srv-1']),
      networkAllowedServerIds: new Set(['srv-1']),
    });

    expect(result.skippedRoutes).toEqual([]);
    expect(result.routes).toEqual([
      '/album/album-1?server=srv-1',
      '/artist/artist-1?server=srv-1',
      '/composer/composer-1?server=srv-1',
      '/label/A%20%26%20B?server=srv-1',
      '/genres/Rock%20%26%20Roll',
      '/playlists/playlist-1?server=srv-1',
    ]);
  });

  it('reports dynamic pages that cannot be resolved safely', () => {
    const result = buildDynamicBenchmarkRoutes({
      albums: [],
      artists: [],
      composers: [],
      playlists: [],
      activeServerId: null,
      configuredServerIds: new Set(),
      networkAllowedServerIds: new Set(),
    });

    expect(result.routes).toEqual([]);
    expect(result.skippedRoutes.map(row => row.route)).toEqual([
      '/album/:id',
      '/artist/:id',
      '/composer/:id',
      '/label/:name',
      '/genres/:name',
      '/playlists/:id',
    ]);
  });

  it('matches owner-qualified routes against the full browser location', () => {
    const location = {
      origin: 'http://localhost:1420',
      pathname: '/album/album-1',
      search: '?server=srv-1',
      hash: '',
    };
    expect(benchmarkRouteMatchesLocation('/album/album-1?server=srv-1', location)).toBe(true);
    expect(benchmarkRouteMatchesLocation('/album/album-1?server=srv-2', location)).toBe(false);
  });

  it('uses a real indexed artist or album name for search interactions', () => {
    expect(benchmarkSearchQueryFromCandidates(
      [{ name: '  Real Artist  ' }],
      [{ name: 'Real Album' }],
    )).toBe('Real Artist');
    expect(benchmarkSearchQueryFromCandidates([], [{ name: '  Real Album  ' }])).toBe('Real Album');
    expect(benchmarkSearchQueryFromCandidates([{ name: '   ' }], [])).toBeNull();
  });
});
