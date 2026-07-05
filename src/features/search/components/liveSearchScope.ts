import type { KeyboardEvent, MouseEvent } from 'react';
import { ALL_NAV_ITEMS } from '@/config/navItems';
import type { LiveSearchScope } from '@/store/liveSearchScopeStore';
import { isAlbumsBrowsePath, isNewReleasesBrowsePath } from '@/features/album';
import { isTracksBrowsePath } from '@/store/advancedSearchSessionStore';
import { isArtistsBrowsePath } from '@/features/artist';
import { isComposersBrowsePath } from '@/features/composers';

export const SCOPE_NAV_ITEM: Record<LiveSearchScope, keyof typeof ALL_NAV_ITEMS> = {
  artists: 'artists',
  albums: 'allAlbums',
  newReleases: 'newReleases',
  tracks: 'tracks',
  composers: 'composers',
};

/** Scope to restore when on a browse route but the badge was cleared (global search mode). */
export function resolveLiveSearchScopeGhost(
  pathname: string,
  activeScope: LiveSearchScope | null,
): LiveSearchScope | null {
  if (activeScope != null) return null;
  if (isArtistsBrowsePath(pathname)) return 'artists';
  if (isAlbumsBrowsePath(pathname)) return 'albums';
  if (isNewReleasesBrowsePath(pathname)) return 'newReleases';
  if (isTracksBrowsePath(pathname)) return 'tracks';
  if (isComposersBrowsePath(pathname)) return 'composers';
  return null;
}

export function liveSearchScopePlaceholderKey(scope: LiveSearchScope | null): string {
  switch (scope) {
    case 'artists':
      return 'search.scopeArtistsPlaceholder';
    case 'albums':
      return 'search.scopeAlbumsPlaceholder';
    case 'newReleases':
      return 'search.scopeNewReleasesPlaceholder';
    case 'tracks':
      return 'search.scopeTracksPlaceholder';
    case 'composers':
      return 'search.scopeComposersPlaceholder';
    default:
      return 'search.placeholder';
  }
}

/** Scoped browse mode filters the page only — no live-search dropdown. */
export function isLiveSearchDropdownBlocked(scope: LiveSearchScope | null): boolean {
  return scope != null;
}

export function liveSearchScopeBadgeTooltipKey(scope: LiveSearchScope): string {
  switch (scope) {
    case 'artists':
      return 'search.scopeArtistsBadgeTooltip';
    case 'albums':
      return 'search.scopeAlbumsBadgeTooltip';
    case 'newReleases':
      return 'search.scopeNewReleasesBadgeTooltip';
    case 'tracks':
      return 'search.scopeTracksBadgeTooltip';
    case 'composers':
      return 'search.scopeComposersBadgeTooltip';
    default:
      return 'search.scopeArtistsBadgeTooltip';
  }
}

export function liveSearchScopeGhostTooltipKey(scope: LiveSearchScope): string {
  switch (scope) {
    case 'artists':
      return 'search.scopeArtistsGhostTooltip';
    case 'albums':
      return 'search.scopeAlbumsGhostTooltip';
    case 'newReleases':
      return 'search.scopeNewReleasesGhostTooltip';
    case 'tracks':
      return 'search.scopeTracksGhostTooltip';
    case 'composers':
      return 'search.scopeComposersGhostTooltip';
    default:
      return 'search.scopeArtistsGhostTooltip';
  }
}

/** Tracks Backspace-on-empty badge removal (double after prior text input). */
export type LiveSearchScopeBackspaceState = {
  hadQueryInput: boolean;
  emptyBackspaceStreak: number;
};

export function createLiveSearchScopeBackspaceState(): LiveSearchScopeBackspaceState {
  return { hadQueryInput: false, emptyBackspaceStreak: 0 };
}

export function resetLiveSearchScopeBackspaceState(state: LiveSearchScopeBackspaceState): void {
  state.hadQueryInput = false;
  state.emptyBackspaceStreak = 0;
}

/** Call when the scoped field query changes (typing, paste, clear button, undo). */
export function noteLiveSearchScopeQueryInput(
  state: LiveSearchScopeBackspaceState,
  query: string,
): void {
  if (query !== '') state.hadQueryInput = true;
}

/**
 * Backspace on an empty scoped field removes the badge.
 * After the user typed text (even if cleared), two consecutive Backspaces on empty are required.
 */
export function handleLiveSearchScopeBackspace(
  e: KeyboardEvent<HTMLInputElement>,
  query: string,
  scope: LiveSearchScope | null,
  clearScope: (options?: { recordUndo?: boolean }) => void,
  state: LiveSearchScopeBackspaceState,
): boolean {
  if (e.key !== 'Backspace' || !scope) return false;

  if (query !== '') {
    state.emptyBackspaceStreak = 0;
    return false;
  }

  e.preventDefault();

  if (!state.hadQueryInput) {
    clearScope({ recordUndo: true });
    resetLiveSearchScopeBackspaceState(state);
    return true;
  }

  state.emptyBackspaceStreak += 1;
  if (state.emptyBackspaceStreak >= 2) {
    clearScope({ recordUndo: true });
    resetLiveSearchScopeBackspaceState(state);
    return true;
  }
  return true;
}

/** Single click removes the scope badge. */
export function handleLiveSearchScopeBadgeClick(
  e: MouseEvent<HTMLElement>,
  clearScope: (options?: { recordUndo?: boolean }) => void,
): void {
  e.preventDefault();
  e.stopPropagation();
  clearScope({ recordUndo: true });
}

/** Single click restores scope after the user cleared the badge on this browse route. */
export function handleLiveSearchScopeGhostClick(
  e: MouseEvent<HTMLElement>,
  scope: LiveSearchScope,
  setScope: (scope: LiveSearchScope, options?: { recordUndo?: boolean }) => void,
): void {
  e.preventDefault();
  e.stopPropagation();
  setScope(scope, { recordUndo: true });
}

/** Field-local undo (Ctrl/Cmd+Z) for live search query and scope badge. */
export function handleLiveSearchScopeUndo(
  e: KeyboardEvent<HTMLInputElement>,
  undo: () => boolean,
): boolean {
  const isUndoKey = e.code === 'KeyZ' || e.key.toLowerCase() === 'z';
  if (!isUndoKey || !(e.ctrlKey || e.metaKey) || e.shiftKey) return false;
  e.preventDefault();
  return undo();
}
