import type { Location, NavigateFunction, NavigationType } from 'react-router-dom';
import {
  isAdvancedSearchPath,
  useAdvancedSearchSessionStore,
} from '@/store/advancedSearchSessionStore';
import {
  isAlbumDetailPath,
  isArtistDetailPath,
  isComposerDetailPath,
} from '@/lib/navigation/detailRoutePaths';
import {
  peekPersistedAdvancedSearchLeaveSnapshot,
  saveAdvancedSearchLeaveSnapshot,
} from '@/lib/navigation/advancedSearchScrollSnapshot';

export type AlbumDetailLocationState = {
  returnTo?: string;
};

export type AlbumsBrowseRestoreLocationState = {
  albumBrowseRestore?: boolean;
  artistBrowseRestore?: boolean;
  composerBrowseRestore?: boolean;
  advancedSearchRestore?: boolean;
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

export function readArtistBrowseRestore(state: unknown): boolean {
  return (state as AlbumsBrowseRestoreLocationState | null)?.artistBrowseRestore === true;
}

export function readComposerBrowseRestore(state: unknown): boolean {
  return (state as AlbumsBrowseRestoreLocationState | null)?.composerBrowseRestore === true;
}

export function readAdvancedSearchRestore(state: unknown): boolean {
  return (state as AlbumsBrowseRestoreLocationState | null)?.advancedSearchRestore === true;
}

export function buildReturnToFromLocation(
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
): string {
  return `${location.pathname}${location.search}${location.hash}`;
}

export function albumBrowseRestoreNavigationState(): AlbumsBrowseRestoreLocationState {
  return { albumBrowseRestore: true };
}

export function artistBrowseRestoreNavigationState(): AlbumsBrowseRestoreLocationState {
  return { artistBrowseRestore: true };
}

export function composerBrowseRestoreNavigationState(): AlbumsBrowseRestoreLocationState {
  return { composerBrowseRestore: true };
}

export function advancedSearchRestoreNavigationState(): AlbumsBrowseRestoreLocationState {
  return { advancedSearchRestore: true };
}

export function shouldRestoreAdvancedSearchSession(
  navigationType: NavigationType,
  locationState: unknown,
): boolean {
  return navigationType === 'POP' || readAdvancedSearchRestore(locationState);
}

export function shouldRestoreAlbumBrowseSession(
  navigationType: NavigationType,
  locationState: unknown,
): boolean {
  return navigationType === 'POP' || readAlbumBrowseRestore(locationState);
}

export function shouldRestoreArtistBrowseSession(
  navigationType: NavigationType,
  locationState: unknown,
): boolean {
  return navigationType === 'POP' || readArtistBrowseRestore(locationState);
}

export function shouldRestoreComposerBrowseSession(
  navigationType: NavigationType,
  locationState: unknown,
): boolean {
  return navigationType === 'POP' || readComposerBrowseRestore(locationState);
}

/** Skip AppShell main scroll reset when a child route will restore scroll itself. */
export function shouldSkipMainScrollResetOnRouteChange(
  pathname: string,
  locationState: unknown,
): boolean {
  if (readAlbumBrowseRestore(locationState)) return true;
  if (readArtistBrowseRestore(locationState)) return true;
  if (readComposerBrowseRestore(locationState)) return true;
  if (readAdvancedSearchRestore(locationState)) return true;
  const leave = useAdvancedSearchSessionStore.getState().peekLeaveScrollSnapshot();
  if ((leave?.scrollTop ?? 0) > 0) return true;
  const stash = useAdvancedSearchSessionStore.getState().peekReturnStash();
  if (isAdvancedSearchPath(pathname) && (stash?.scrollTop ?? 0) > 0) return true;
  if (isAdvancedSearchPath(pathname)) {
    const persisted = peekPersistedAdvancedSearchLeaveSnapshot();
    if ((persisted?.scrollTop ?? 0) > 0) return true;
  }
  return false;
}

function isAlbumGridBrowseReturnPath(path: string): boolean {
  return path === '/albums' || path.startsWith('/albums?')
    || path === '/new-releases' || path.startsWith('/new-releases?')
    || path === '/random/albums' || path.startsWith('/random/albums?');
}

function isSearchReturnPath(path: string): boolean {
  return path === '/search' || path.startsWith('/search?')
    || path === '/search/advanced' || path.startsWith('/search/advanced?')
    || path === '/tracks' || path.startsWith('/tracks?');
}

function isArtistsBrowseReturnPath(path: string): boolean {
  return path === '/artists' || path.startsWith('/artists?');
}

function isComposersBrowseReturnPath(path: string): boolean {
  return path === '/composers' || path.startsWith('/composers?');
}

function isGenreDetailReturnPath(path: string): boolean {
  const bare = path.split('?')[0]?.replace(/\/$/, '') || path;
  return /^\/genres\/[^/]+$/.test(bare);
}

function browseReturnRestoreState(returnTo: string): AlbumsBrowseRestoreLocationState | undefined {
  if (isAlbumGridBrowseReturnPath(returnTo)) return albumBrowseRestoreNavigationState();
  if (isGenreDetailReturnPath(returnTo)) return albumBrowseRestoreNavigationState();
  if (isArtistsBrowseReturnPath(returnTo)) return artistBrowseRestoreNavigationState();
  if (isComposersBrowseReturnPath(returnTo)) return composerBrowseRestoreNavigationState();
  if (isSearchReturnPath(returnTo)) return advancedSearchRestoreNavigationState();
  return undefined;
}

function buildReturnTo(
  location: Pick<Location, 'pathname' | 'search' | 'hash' | 'state'>,
): string {
  const existing = readAlbumDetailReturnTo(location.state);
  const onDetail = isAlbumDetailPath(location.pathname)
    || isArtistDetailPath(location.pathname)
    || isComposerDetailPath(location.pathname);
  return onDetail && existing ? existing : buildReturnToFromLocation(location);
}

function saveSearchLeaveIfNeeded(
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
): void {
  if (isAdvancedSearchPath(location.pathname)) {
    saveAdvancedSearchLeaveSnapshot();
  }
}

export function navigateToAlbumDetail(
  navigate: NavigateFunction,
  location: Pick<Location, 'pathname' | 'search' | 'hash' | 'state'>,
  albumId: string,
  opts?: { search?: string },
): void {
  saveSearchLeaveIfNeeded(location);
  const returnTo = buildReturnTo(location);
  const raw = opts?.search ?? '';
  const qs = raw ? (raw.startsWith('?') ? raw : `?${raw}`) : '';
  navigate(`/album/${albumId}${qs}`, { state: { returnTo } satisfies AlbumDetailLocationState });
}

export function navigateToArtistDetail(
  navigate: NavigateFunction,
  location: Pick<Location, 'pathname' | 'search' | 'hash' | 'state'>,
  artistId: string,
  opts?: { search?: string },
): void {
  saveSearchLeaveIfNeeded(location);
  const returnTo = buildReturnTo(location);
  const raw = opts?.search ?? '';
  const qs = raw ? (raw.startsWith('?') ? raw : `?${raw}`) : '';
  navigate(`/artist/${artistId}${qs}`, { state: { returnTo } satisfies AlbumDetailLocationState });
}

export function navigateToComposerDetail(
  navigate: NavigateFunction,
  location: Pick<Location, 'pathname' | 'search' | 'hash' | 'state'>,
  composerId: string,
  opts?: { search?: string },
): void {
  saveSearchLeaveIfNeeded(location);
  const returnTo = buildReturnTo(location);
  const raw = opts?.search ?? '';
  const qs = raw ? (raw.startsWith('?') ? raw : `?${raw}`) : '';
  navigate(`/composer/${composerId}${qs}`, { state: { returnTo } satisfies AlbumDetailLocationState });
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
    const restoreState = browseReturnRestoreState(returnTo);
    navigate(returnTo, restoreState ? { state: restoreState } : undefined);
    return;
  }
  if (window.history.length > 1) navigate(-1);
  else navigate(fallback);
}
