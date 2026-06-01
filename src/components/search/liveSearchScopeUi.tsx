import type { KeyboardEvent, MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ALL_NAV_ITEMS } from '../../config/navItems';
import type { LiveSearchScope } from '../../store/liveSearchScopeStore';

const SCOPE_NAV_ITEM: Record<LiveSearchScope, keyof typeof ALL_NAV_ITEMS> = {
  artists: 'artists',
};

export function liveSearchScopePlaceholderKey(scope: LiveSearchScope | null): string {
  switch (scope) {
    case 'artists':
      return 'search.scopeArtistsPlaceholder';
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
    default:
      return 'search.scopeArtistsBadgeTooltip';
  }
}

type LiveSearchScopeIconProps = {
  scope: LiveSearchScope;
  size?: number;
};

/** Sidebar nav icon for the scoped browse page (e.g. Users for Artists). */
export function LiveSearchScopeIcon({ scope, size = 14 }: LiveSearchScopeIconProps) {
  const Icon = ALL_NAV_ITEMS[SCOPE_NAV_ITEM[scope]].icon;
  return <Icon size={size} aria-hidden />;
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

/** Double-click removes the scope badge. */
export function handleLiveSearchScopeBadgeDoubleClick(
  e: MouseEvent<HTMLElement>,
  clearScope: (options?: { recordUndo?: boolean }) => void,
): void {
  e.preventDefault();
  e.stopPropagation();
  clearScope({ recordUndo: true });
}

type LiveSearchScopeBadgeProps = {
  scope: LiveSearchScope;
  className: string;
  clearScope: (options?: { recordUndo?: boolean }) => void;
};

export function LiveSearchScopeBadge({ scope, className, clearScope }: LiveSearchScopeBadgeProps) {
  const { t } = useTranslation();
  const tooltip = t(liveSearchScopeBadgeTooltipKey(scope));
  return (
    <span
      className={className}
      role="button"
      tabIndex={-1}
      data-tooltip={tooltip}
      data-tooltip-pos="bottom"
      aria-label={tooltip}
      onMouseDown={(e) => e.preventDefault()}
      onDoubleClick={(e) => handleLiveSearchScopeBadgeDoubleClick(e, clearScope)}
    >
      <LiveSearchScopeIcon scope={scope} size={14} />
    </span>
  );
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
