import { describe, expect, it, vi, afterEach } from 'vitest';
import type { NavigationType } from 'react-router-dom';
import {
  buildReturnToFromLocation,
  navigateAlbumDetailBack,
  navigatePathWithAlbumReturnTo,
  navigateToAlbumDetail,
  navigateToArtistDetail,
  navigateToComposerDetail,
  readAlbumDetailReturnTo,
  shouldRestoreAlbumBrowseSession,
  shouldRestoreArtistBrowseSession,
  shouldRestoreComposerBrowseSession,
  shouldSkipMainScrollResetOnRouteChange,
} from '@/lib/navigation/albumDetailNavigation';
import { useAdvancedSearchSessionStore } from '@/store/advancedSearchSessionStore';

describe('albumDetailNavigation', () => {
  afterEach(() => {
    useAdvancedSearchSessionStore.getState().clearLeaveScrollSnapshot();
  });

  it('reads returnTo from location state', () => {
    expect(readAlbumDetailReturnTo({ returnTo: '/artist/abc' })).toBe('/artist/abc');
    expect(readAlbumDetailReturnTo({ returnTo: 'bad' })).toBeNull();
    expect(readAlbumDetailReturnTo(null)).toBeNull();
  });

  it('detects album browse restore navigation', () => {
    expect(shouldRestoreAlbumBrowseSession('POP' as NavigationType, null)).toBe(true);
    expect(shouldRestoreAlbumBrowseSession('PUSH' as NavigationType, { albumBrowseRestore: true })).toBe(true);
    expect(shouldRestoreAlbumBrowseSession('PUSH' as NavigationType, null)).toBe(false);
  });

  it('navigates to album with returnTo snapshot', () => {
    const navigate = vi.fn();
    navigateToAlbumDetail(navigate, { pathname: '/artist/a', search: '', hash: '', state: null }, 'alb-1');
    expect(navigate).toHaveBeenCalledWith('/album/alb-1', { state: { returnTo: '/artist/a' } });
  });

  it('preserves returnTo when opening a related album', () => {
    const navigate = vi.fn();
    navigateToAlbumDetail(
      navigate,
      {
        pathname: '/album/parent',
        search: '',
        hash: '',
        state: { returnTo: '/albums' },
      },
      'child',
    );
    expect(navigate).toHaveBeenCalledWith('/album/child', { state: { returnTo: '/albums' } });
  });

  it('routes album paths through returnTo helper', () => {
    const navigate = vi.fn();
    navigatePathWithAlbumReturnTo(
      navigate,
      { pathname: '/', search: '', hash: '', state: null },
      '/album/x?lossless=1',
    );
    expect(navigate).toHaveBeenCalledWith('/album/x?lossless=1', { state: { returnTo: '/' } });
  });

  it('navigates back to saved returnTo', () => {
    const navigate = vi.fn();
    navigateAlbumDetailBack(navigate, { state: { returnTo: '/genres/Rock' } });
    expect(navigate).toHaveBeenCalledWith('/genres/Rock', { state: { albumBrowseRestore: true } });
  });

  it('flags All Albums return for browse restore', () => {
    const navigate = vi.fn();
    navigateAlbumDetailBack(navigate, { state: { returnTo: '/albums' } });
    expect(navigate).toHaveBeenCalledWith('/albums', { state: { albumBrowseRestore: true } });
  });

  it('flags New Releases and Random Albums return for browse restore', () => {
    const navigate = vi.fn();
    navigateAlbumDetailBack(navigate, { state: { returnTo: '/new-releases' } });
    expect(navigate).toHaveBeenCalledWith('/new-releases', { state: { albumBrowseRestore: true } });
    navigate.mockClear();
    navigateAlbumDetailBack(navigate, { state: { returnTo: '/random/albums' } });
    expect(navigate).toHaveBeenCalledWith('/random/albums', { state: { albumBrowseRestore: true } });
  });

  it('flags Artists browse return for session restore', () => {
    const navigate = vi.fn();
    navigateAlbumDetailBack(navigate, { state: { returnTo: '/artists' } });
    expect(navigate).toHaveBeenCalledWith('/artists', { state: { artistBrowseRestore: true } });
  });

  it('flags Composers browse return for session restore', () => {
    const navigate = vi.fn();
    navigateAlbumDetailBack(navigate, { state: { returnTo: '/composers' } });
    expect(navigate).toHaveBeenCalledWith('/composers', { state: { composerBrowseRestore: true } });
  });

  it('detects composer browse restore navigation', () => {
    expect(shouldRestoreComposerBrowseSession('POP' as NavigationType, null)).toBe(true);
    expect(shouldRestoreComposerBrowseSession('PUSH' as NavigationType, { composerBrowseRestore: true })).toBe(true);
    expect(shouldRestoreComposerBrowseSession('PUSH' as NavigationType, null)).toBe(false);
  });

  it('detects artist browse restore navigation', () => {
    expect(shouldRestoreArtistBrowseSession('POP' as NavigationType, null)).toBe(true);
    expect(shouldRestoreArtistBrowseSession('PUSH' as NavigationType, { artistBrowseRestore: true })).toBe(true);
    expect(shouldRestoreArtistBrowseSession('PUSH' as NavigationType, null)).toBe(false);
  });

  it('flags Advanced Search return for session restore', () => {
    const navigate = vi.fn();
    navigateAlbumDetailBack(navigate, { state: { returnTo: '/search/advanced?q=rock' } });
    expect(navigate).toHaveBeenCalledWith('/search/advanced?q=rock', {
      state: { advancedSearchRestore: true },
    });
  });

  it('flags Search return for session restore (basic, advanced, and tracks paths)', () => {
    const navigate = vi.fn();
    navigateAlbumDetailBack(navigate, { state: { returnTo: '/search?q=rock' } });
    expect(navigate).toHaveBeenCalledWith('/search?q=rock', {
      state: { advancedSearchRestore: true },
    });
    navigate.mockClear();
    navigateAlbumDetailBack(navigate, { state: { returnTo: '/search/advanced?q=rock' } });
    expect(navigate).toHaveBeenCalledWith('/search/advanced?q=rock', {
      state: { advancedSearchRestore: true },
    });
    navigate.mockClear();
    navigateAlbumDetailBack(navigate, { state: { returnTo: '/tracks' } });
    expect(navigate).toHaveBeenCalledWith('/tracks', {
      state: { advancedSearchRestore: true },
    });
  });

  it('navigates to artist with returnTo snapshot from Advanced Search', () => {
    const navigate = vi.fn();
    navigateToArtistDetail(
      navigate,
      { pathname: '/search/advanced', search: '?q=rock', hash: '', state: null },
      'art-1',
    );
    expect(navigate).toHaveBeenCalledWith('/artist/art-1', {
      state: { returnTo: '/search/advanced?q=rock' },
    });
  });

  it('navigates to composer with returnTo snapshot from Composers browse', () => {
    const navigate = vi.fn();
    navigateToComposerDetail(
      navigate,
      { pathname: '/composers', search: '', hash: '', state: null },
      'comp-1',
    );
    expect(navigate).toHaveBeenCalledWith('/composer/comp-1', {
      state: { returnTo: '/composers' },
    });
  });

  it('skips main scroll reset when All Albums browse restore is pending', () => {
    expect(shouldSkipMainScrollResetOnRouteChange('/albums', { albumBrowseRestore: true })).toBe(true);
    expect(shouldSkipMainScrollResetOnRouteChange('/new-releases', { albumBrowseRestore: true })).toBe(true);
    expect(shouldSkipMainScrollResetOnRouteChange('/random/albums', { albumBrowseRestore: true })).toBe(true);
    expect(shouldSkipMainScrollResetOnRouteChange('/tracks', null)).toBe(false);
  });

  it('skips main scroll reset when Artists browse restore is pending', () => {
    expect(shouldSkipMainScrollResetOnRouteChange('/artists', { artistBrowseRestore: true })).toBe(true);
  });

  it('skips main scroll reset when Composers browse restore is pending', () => {
    expect(shouldSkipMainScrollResetOnRouteChange('/composers', { composerBrowseRestore: true })).toBe(true);
  });

  it('skips main scroll reset when Advanced Search session restore is pending', () => {
    expect(shouldSkipMainScrollResetOnRouteChange('/search/advanced', { advancedSearchRestore: true })).toBe(true);
  });

  it('skips main scroll reset when Search session restore is pending', () => {
    expect(shouldSkipMainScrollResetOnRouteChange('/search', { advancedSearchRestore: true })).toBe(true);
    expect(shouldSkipMainScrollResetOnRouteChange('/tracks', { advancedSearchRestore: true })).toBe(true);
  });

  it('skips main scroll reset when Advanced Search vertical scroll restore is pending', () => {
    useAdvancedSearchSessionStore.getState().setLeaveScrollSnapshot({
      scrollTop: 420,
      albumRowScrollLeft: 0,
      artistRowScrollLeft: 0,
    });
    expect(shouldSkipMainScrollResetOnRouteChange('/search/advanced', null)).toBe(true);
    expect(shouldSkipMainScrollResetOnRouteChange('/tracks', null)).toBe(true);
  });

  it('skips main scroll reset when Advanced Search return stash carries scrollTop', () => {
    useAdvancedSearchSessionStore.getState().stashReturnSession({
      query: 'jazz',
      genre: '',
      yearFrom: '',
      yearTo: '',
      bpmFrom: '',
      bpmTo: '',
      moodGroup: '',
      losslessOnly: false,
      resultType: 'all',
      starredOnly: false,
      results: { artists: [], albums: [], songs: [] },
      hasSearched: true,
      activeSearch: null,
      localMode: false,
      songsServerOffset: 0,
      songsHasMore: false,
      genreNote: false,
      basicSearchMode: false,
      tracksBrowseMode: true,
      scrollTop: 880,
    });
    expect(shouldSkipMainScrollResetOnRouteChange('/tracks', null)).toBe(true);
  });

  it('builds return path with search and hash', () => {
    expect(buildReturnToFromLocation({
      pathname: '/tracks',
      search: '?q=test',
      hash: '#top',
    })).toBe('/tracks?q=test#top');
  });
});
