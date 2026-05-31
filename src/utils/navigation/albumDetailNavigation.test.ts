import { describe, expect, it, vi } from 'vitest';
import type { NavigationType } from 'react-router-dom';
import {
  buildReturnToFromLocation,
  navigateAlbumDetailBack,
  navigatePathWithAlbumReturnTo,
  navigateToAlbumDetail,
  readAlbumDetailReturnTo,
  shouldRestoreAlbumBrowseSession,
} from './albumDetailNavigation';

describe('albumDetailNavigation', () => {
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

  it('builds return path with search and hash', () => {
    expect(buildReturnToFromLocation({
      pathname: '/tracks',
      search: '?q=test',
      hash: '#top',
    })).toBe('/tracks?q=test#top');
  });
});
