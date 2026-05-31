import { describe, expect, it, vi, afterEach } from 'vitest';
import type { NavigationType } from 'react-router-dom';
import {
  buildReturnToFromLocation,
  navigateAlbumDetailBack,
  navigatePathWithAlbumReturnTo,
  navigateToAlbumDetail,
  navigateToArtistDetail,
  readAlbumDetailReturnTo,
  shouldRestoreAlbumBrowseSession,
  shouldSkipMainScrollResetOnRouteChange,
} from './albumDetailNavigation';
import { useAdvancedSearchSessionStore } from '../../store/advancedSearchSessionStore';

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
    expect(navigate).toHaveBeenCalledWith('/genres/Rock', undefined);
  });

  it('flags All Albums return for browse restore', () => {
    const navigate = vi.fn();
    navigateAlbumDetailBack(navigate, { state: { returnTo: '/albums' } });
    expect(navigate).toHaveBeenCalledWith('/albums', { state: { albumBrowseRestore: true } });
  });

  it('flags Advanced Search return for session restore', () => {
    const navigate = vi.fn();
    navigateAlbumDetailBack(navigate, { state: { returnTo: '/search/advanced?q=rock' } });
    expect(navigate).toHaveBeenCalledWith('/search/advanced?q=rock', {
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

  it('skips main scroll reset when All Albums browse restore is pending', () => {
    expect(shouldSkipMainScrollResetOnRouteChange('/albums', { albumBrowseRestore: true })).toBe(true);
    expect(shouldSkipMainScrollResetOnRouteChange('/tracks', null)).toBe(false);
  });

  it('skips main scroll reset when Advanced Search session restore is pending', () => {
    expect(shouldSkipMainScrollResetOnRouteChange('/search/advanced', { advancedSearchRestore: true })).toBe(true);
  });

  it('skips main scroll reset when Advanced Search vertical scroll restore is pending', () => {
    useAdvancedSearchSessionStore.getState().setLeaveScrollSnapshot({
      scrollTop: 420,
      albumRowScrollLeft: 0,
    });
    expect(shouldSkipMainScrollResetOnRouteChange('/search/advanced', null)).toBe(true);
  });

  it('builds return path with search and hash', () => {
    expect(buildReturnToFromLocation({
      pathname: '/tracks',
      search: '?q=test',
      hash: '#top',
    })).toBe('/tracks?q=test#top');
  });
});
