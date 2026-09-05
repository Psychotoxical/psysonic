import type { Location, NavigateFunction, NavigationType } from 'react-router';
import {
  isAdvancedSearchPath,
  useAdvancedSearchSessionStore,
} from '@/store/advancedSearchSessionStore';
import {
  isAlbumDetailPath,
  isArtistDetailPath,
  isComposerDetailPath,
  isPlaylistDetailPath,
} from '@/lib/navigation/detailRoutePaths';
import {
  peekPersistedAdvancedSearchLeaveSnapshot,
  saveAdvancedSearchLeaveSnapshot,
} from '@/lib/navigation/advancedSearchScrollSnapshot';
import {
  buildAlbumDetailPath,
  buildArtistDetailPath,
  buildComposerDetailPath,
  type ArtistDetailPathOptions,
} from '@/lib/navigation/detailServerScope';
import { APP_MAIN_SCROLL_VIEWPORT_ID } from '@/constants/appScroll';

export type AlbumDetailLocationState = {
  returnTo?: string;
  returnState?: AlbumDetailLocationState;
  playlistDetailScrollTop?: number;
};

export type AlbumsBrowseRestoreLocationState = {
  albumBrowseRestore?: boolean;
  artistBrowseRestore?: boolean;
  composerBrowseRestore?: boolean;
  advancedSearchRestore?: boolean;
  playlistDetailScrollTop?: number;
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

export function readPlaylistDetailScrollTop(state: unknown): number | null {
  const scrollTop = (state as AlbumDetailLocationState | null)?.playlistDetailScrollTop;
  if (typeof scrollTop !== 'number' || !Number.isFinite(scrollTop)) return null;
  return Math.max(0, scrollTop);
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

export function playlistDetailRestoreNavigationState(
  scrollTop: number,
): AlbumsBrowseRestoreLocationState {
  return { playlistDetailScrollTop: Math.max(0, scrollTop) };
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
  if (isPlaylistDetailPath(pathname) && readPlaylistDetailScrollTop(locationState) !== null) return true;
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

function browseReturnRestoreState(
  returnTo: string,
  detailState: unknown,
): AlbumsBrowseRestoreLocationState | undefined {
  if (isAlbumGridBrowseReturnPath(returnTo)) return albumBrowseRestoreNavigationState();
  if (isGenreDetailReturnPath(returnTo)) return albumBrowseRestoreNavigationState();
  if (isArtistsBrowseReturnPath(returnTo)) return artistBrowseRestoreNavigationState();
  if (isComposersBrowseReturnPath(returnTo)) return composerBrowseRestoreNavigationState();
  if (isSearchReturnPath(returnTo)) return advancedSearchRestoreNavigationState();
  if (isPlaylistDetailPath(returnTo)) {
    const scrollTop = readPlaylistDetailScrollTop(detailState);
    if (scrollTop !== null) return playlistDetailRestoreNavigationState(scrollTop);
  }
  return undefined;
}

function playlistDetailScrollTopForLocation(pathname: string): number | null {
  if (!isPlaylistDetailPath(pathname)) return null;
  const scrollTop = typeof document === 'undefined'
    ? 0
    : (document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID)?.scrollTop ?? 0);
  return Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
}

function buildDetailLocationState(
  location: Pick<Location, 'pathname' | 'search' | 'hash' | 'state'>,
): AlbumDetailLocationState {
  const returnTo = buildReturnToFromLocation(location);
  const onDetail = isAlbumDetailPath(location.pathname)
    || isArtistDetailPath(location.pathname)
    || isComposerDetailPath(location.pathname);
  const existing = readAlbumDetailReturnTo(location.state);
  const playlistDetailScrollTop = playlistDetailScrollTopForLocation(location.pathname);
  return onDetail && existing
    ? { returnTo, returnState: location.state as AlbumDetailLocationState }
    : {
      returnTo,
      ...(playlistDetailScrollTop !== null
        ? { playlistDetailScrollTop }
        : {}),
    };
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
  opts?: ArtistDetailPathOptions,
): void {
  saveSearchLeaveIfNeeded(location);
  navigate(buildAlbumDetailPath(albumId, opts), {
    state: buildDetailLocationState(location),
  });
}

export function navigateToArtistDetail(
  navigate: NavigateFunction,
  location: Pick<Location, 'pathname' | 'search' | 'hash' | 'state'>,
  artistId: string,
  opts?: ArtistDetailPathOptions,
): void {
  saveSearchLeaveIfNeeded(location);
  navigate(buildArtistDetailPath(artistId, opts), {
    state: buildDetailLocationState(location),
  });
}

export function navigateToComposerDetail(
  navigate: NavigateFunction,
  location: Pick<Location, 'pathname' | 'search' | 'hash' | 'state'>,
  composerId: string,
  opts?: ArtistDetailPathOptions,
): void {
  saveSearchLeaveIfNeeded(location);
  navigate(buildComposerDetailPath(composerId, opts), {
    state: buildDetailLocationState(location),
  });
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
    const restoreState = browseReturnRestoreState(returnTo, location.state);
    const returnState = (location.state as AlbumDetailLocationState | null)?.returnState;
    const state = readAlbumDetailReturnTo(returnState) ? returnState : restoreState;
    navigate(returnTo, state ? { state } : undefined);
    return;
  }
  if (window.history.length > 1) navigate(-1);
  else navigate(fallback);
}
