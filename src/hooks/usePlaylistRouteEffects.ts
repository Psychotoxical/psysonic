import React, { useEffect } from 'react';
import type { Location, NavigateFunction } from 'react-router-dom';
import { usePlayerStore } from '../store/playerStore';

export interface PlaylistRouteEffectsDeps {
  setContextMenuSongId: React.Dispatch<React.SetStateAction<string | null>>;
  setEditingMeta: React.Dispatch<React.SetStateAction<boolean>>;
  location: Location;
  navigate: NavigateFunction;
}

export function usePlaylistRouteEffects(deps: PlaylistRouteEffectsDeps): void {
  const { setContextMenuSongId, setEditingMeta, location, navigate } = deps;
  const contextMenuOpen = usePlayerStore(s => s.contextMenu.isOpen);

  useEffect(() => {
    if (!contextMenuOpen) setContextMenuSongId(null);
  }, [contextMenuOpen, setContextMenuSongId]);

  useEffect(() => {
    const state = (location.state as { openEditMeta?: boolean } | null) ?? null;
    if (state?.openEditMeta) {
      setEditingMeta(true);
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.state, location.pathname, navigate, setEditingMeta]);
}
