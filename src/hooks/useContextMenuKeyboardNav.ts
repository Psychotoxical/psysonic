import React, { useCallback, useEffect } from 'react';

type RatingKind = 'song' | 'album' | 'artist';

interface KeyboardRating {
  kind: RatingKind;
  id: string;
  value: number;
}

interface Args {
  menuRef: React.RefObject<HTMLDivElement | null>;
  isOpen: boolean;
  closeContextMenu: () => void;
  keyboardRating: KeyboardRating | null;
  setKeyboardRating: React.Dispatch<React.SetStateAction<KeyboardRating | null>>;
  getRatingValueByKind: (kind: RatingKind, id: string) => number;
  commitRatingByKind: (kind: RatingKind, id: string, rating: number) => void;
  playlistSubmenuOpen: boolean;
  setPlaylistSubmenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setPlaylistSongIds: React.Dispatch<React.SetStateAction<string[]>>;
  pendingSubmenuKeyboardFocus: boolean;
  setPendingSubmenuKeyboardFocus: React.Dispatch<React.SetStateAction<boolean>>;
}

interface Result {
  onMenuKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  getMenuNavItems: (scope?: 'main' | 'submenu') => HTMLElement[];
  focusMenuItemAt: (scope: 'main' | 'submenu', index: number) => void;
}

export function useContextMenuKeyboardNav({
  menuRef, isOpen, closeContextMenu,
  keyboardRating, setKeyboardRating, getRatingValueByKind, commitRatingByKind,
  playlistSubmenuOpen, setPlaylistSubmenuOpen, setPlaylistSongIds,
  pendingSubmenuKeyboardFocus, setPendingSubmenuKeyboardFocus,
}: Args): Result {
  const getMenuNavItems = useCallback(
    (scope: 'main' | 'submenu' = 'main') => {
      if (!menuRef.current) return [];
      if (scope === 'submenu') {
        const sub = menuRef.current.querySelector<HTMLElement>('.context-submenu');
        if (!sub || sub.offsetParent === null) return [];
        return Array.from(
          sub.querySelectorAll<HTMLElement>('.context-menu-item, .context-submenu-create-btn'),
        ).filter(el => el.offsetParent !== null);
      }
      return Array.from(menuRef.current.children)
        .filter((el): el is HTMLElement =>
          el instanceof HTMLElement &&
          (el.classList.contains('context-menu-item') || el.classList.contains('context-menu-rating-row')) &&
          el.offsetParent !== null,
        );
    },
    [menuRef],
  );

  const focusMenuItemAt = useCallback((scope: 'main' | 'submenu', index: number) => {
    const items = getMenuNavItems(scope);
    if (items.length === 0) return;
    menuRef.current
      ?.querySelectorAll<HTMLElement>('.context-menu-keyboard-active')
      .forEach(el => el.classList.remove('context-menu-keyboard-active'));
    const safeIdx = ((index % items.length) + items.length) % items.length;
    const target = items[safeIdx];
    target.classList.add('context-menu-keyboard-active');
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest' });
  }, [getMenuNavItems, menuRef]);

  // Focus the menu container when it opens (no row pre-highlight; keyboard outline
  // only appears after explicit arrow navigation).
  useEffect(() => {
    if (!isOpen) return;
    requestAnimationFrame(() => {
      menuRef.current?.focus({ preventScroll: true });
    });
  }, [isOpen, menuRef]);

  // Outside-click closes the menu without occluding the underlying UI.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      closeContextMenu();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen, closeContextMenu, menuRef]);

  // After opening a submenu via keyboard, wait for it to render then focus first item.
  useEffect(() => {
    if (!pendingSubmenuKeyboardFocus || !playlistSubmenuOpen) return;
    let cancelled = false;
    const tryFocus = (attemptsLeft: number) => {
      if (cancelled) return;
      const items = getMenuNavItems('submenu');
      if (items.length > 0) {
        focusMenuItemAt('submenu', 0);
        setPendingSubmenuKeyboardFocus(false);
        return;
      }
      if (attemptsLeft <= 0) {
        setPendingSubmenuKeyboardFocus(false);
        return;
      }
      requestAnimationFrame(() => tryFocus(attemptsLeft - 1));
    };
    requestAnimationFrame(() => tryFocus(8));
    return () => { cancelled = true; };
  }, [pendingSubmenuKeyboardFocus, playlistSubmenuOpen, getMenuNavItems, focusMenuItemAt, setPendingSubmenuKeyboardFocus]);

  const onMenuKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const active = document.activeElement as HTMLElement | null;
    const ratingRow = active?.closest('.context-menu-rating-row') as HTMLElement | null;

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeContextMenu();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (ratingRow) {
        const kind = ratingRow.dataset.ratingKind as RatingKind | undefined;
        const id = ratingRow.dataset.ratingId;
        if (!kind || !id) return;
        if (ratingRow.dataset.ratingDisabled === 'true') return;
        const value = keyboardRating && keyboardRating.kind === kind && keyboardRating.id === id
          ? keyboardRating.value
          : getRatingValueByKind(kind, id);
        commitRatingByKind(kind, id, value);
        setKeyboardRating({ kind, id, value });
        return;
      }
      active?.click();
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (ratingRow) {
        const kind = ratingRow.dataset.ratingKind as RatingKind | undefined;
        const id = ratingRow.dataset.ratingId;
        if (!kind || !id) return;
        if (ratingRow.dataset.ratingDisabled === 'true') return;
        e.preventDefault();
        e.stopPropagation();
        const currentValue = keyboardRating && keyboardRating.kind === kind && keyboardRating.id === id
          ? keyboardRating.value
          : getRatingValueByKind(kind, id);
        const delta = e.key === 'ArrowRight' ? 1 : -1;
        const nextValue = Math.max(0, Math.min(5, currentValue + delta));
        setKeyboardRating({ kind, id, value: nextValue });
        return;
      }
    }
    if (e.key === 'ArrowRight') {
      const trigger = active?.closest('.context-menu-item--submenu') as HTMLElement | null;
      const triggerId = trigger?.dataset.playlistTriggerId;
      if (!trigger || !triggerId) return;
      e.preventDefault();
      e.stopPropagation();
      setPlaylistSongIds([triggerId]);
      setPlaylistSubmenuOpen(true);
      setPendingSubmenuKeyboardFocus(true);
      return;
    }
    if (e.key === 'ArrowLeft') {
      const sub = active?.closest('.context-submenu') as HTMLElement | null;
      if (!sub) return;
      e.preventDefault();
      e.stopPropagation();
      const triggerId = sub.dataset.parentTriggerId;
      setPlaylistSubmenuOpen(false);
      requestAnimationFrame(() => {
        const trigger = triggerId
          ? Array.from(menuRef.current?.querySelectorAll<HTMLElement>('.context-menu-item--submenu') ?? [])
              .find(el => el.dataset.playlistTriggerId === triggerId) ?? null
          : null;
        if (trigger) {
          menuRef.current
            ?.querySelectorAll<HTMLElement>('.context-menu-keyboard-active')
            .forEach(el => el.classList.remove('context-menu-keyboard-active'));
          trigger.classList.add('context-menu-keyboard-active');
          trigger.focus({ preventScroll: true });
        }
      });
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    e.stopPropagation();
    const scope: 'main' | 'submenu' = active?.closest('.context-submenu') ? 'submenu' : 'main';
    const items = getMenuNavItems(scope);
    if (items.length === 0) return;
    const activeIdx = items.findIndex(el => el === document.activeElement);
    const nextIdx =
      activeIdx >= 0
        ? (e.key === 'ArrowDown' ? activeIdx + 1 : activeIdx - 1)
        : (e.key === 'ArrowDown' ? 0 : items.length - 1);
    focusMenuItemAt(scope, nextIdx);
  }, [
    closeContextMenu, keyboardRating, getRatingValueByKind, commitRatingByKind,
    getMenuNavItems, focusMenuItemAt, menuRef,
    setKeyboardRating, setPlaylistSubmenuOpen, setPlaylistSongIds, setPendingSubmenuKeyboardFocus,
  ]);

  return { onMenuKeyDown, getMenuNavItems, focusMenuItemAt };
}
