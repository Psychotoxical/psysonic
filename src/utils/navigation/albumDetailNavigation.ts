import type { Location, NavigateFunction, NavigationType } from 'react-router-dom';
import { isAlbumDetailPath } from '../../store/albumBrowseSessionStore';

export type AlbumDetailLocationState = {
  returnTo?: string;
};

export type AlbumsBrowseRestoreLocationState = {
  albumBrowseRestore?: boolean;
};

export function readAlbumDetailReturnTo(state: unknown): string | null {
  const returnTo = (state as AlbumDetailLocationState | null)?.returnTo;
  if (typeof returnTo !== 'string' || returnTo.length === 0) return null;
  if (!returnTo.startsWith('/')) return null;
  return returnTo;
}

export function readAlbumBrowseRestore(state: unknown): boolean {
  return (state as AlbumsBrowseRestoreLocationState | null)?.albumBrowseRestore === true;
}

export function buildReturnToFromLocation(
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
): string {
  return `${location.pathname}${location.search}${location.hash}`;
}

export function albumBrowseRestoreNavigationState(): AlbumsBrowseRestoreLocationState {
  return { albumBrowseRestore: true };
}

export function shouldRestoreAlbumBrowseSession(
  navigationType: NavigationType,
  locationState: unknown,
): boolean {
  return navigationType === 'POP' || readAlbumBrowseRestore(locationState);
}

function isAlbumsBrowseReturnPath(path: string): boolean {
  return path === '/albums' || path.startsWith('/albums?');
}

export function navigateToAlbumDetail(
  navigate: NavigateFunction,
  location: Pick<Location, 'pathname' | 'search' | 'hash' | 'state'>,
  albumId: string,
  opts?: { search?: string },
): void {
  const existing = readAlbumDetailReturnTo(location.state);
  const onAlbumDetail = isAlbumDetailPath(location.pathname);
  const returnTo = onAlbumDetail && existing
    ? existing
    : buildReturnToFromLocation(location);
  const raw = opts?.search ?? '';
  const qs = raw ? (raw.startsWith('?') ? raw : `?${raw}`) : '';
  navigate(`/album/${albumId}${qs}`, { state: { returnTo } satisfies AlbumDetailLocationState });
}

/** Route any path; album detail links get a `returnTo` snapshot in location state. */
export function navigatePathWithAlbumReturnTo(
  navigate: NavigateFunction,
  location: Pick<Location, 'pathname' | 'search' | 'hash' | 'state'>,
  path: string,
): void {
  const albumMatch = path.match(/^\/album\/([^/?#]+)(\?[^#]*)?/);
  if (!albumMatch) {
    navigate(path);
    return;
  }
  const [, albumId, search = ''] = albumMatch;
  navigateToAlbumDetail(navigate, location, albumId, { search });
}

export function navigateAlbumDetailBack(
  navigate: NavigateFunction,
  location: Pick<Location, 'state'>,
  fallback = '/',
): void {
  const returnTo = readAlbumDetailReturnTo(location.state);
  if (returnTo) {
    navigate(
      returnTo,
      isAlbumsBrowseReturnPath(returnTo)
        ? { state: albumBrowseRestoreNavigationState() }
        : undefined,
    );
    return;
  }
  if (window.history.length > 1) navigate(-1);
  else navigate(fallback);
}
