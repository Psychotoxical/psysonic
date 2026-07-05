import { useEffect, useRef } from 'react';
import type { Location, NavigateFunction } from 'react-router-dom';
import { resolveOfflineDisconnectNavAction } from '@/features/offline/utils/offlineBrowseRouting';

type ConnStatus = 'connected' | 'disconnected' | 'connecting' | 'unknown';

type OfflineAutoNavContext = {
  favoritesOfflineBrowse: boolean;
  localLibraryBrowse: boolean;
  playerStatsBrowse: boolean;
  playlistsOfflineBrowse: boolean;
  hasManualOfflineContent: boolean;
};

/**
 * On disconnect:
 *  - No offline browse content → stay on the current page (banner only).
 *  - Offline-capable route → stay and bump location state so data hooks reload.
 *  - Otherwise → redirect to All Albums.
 *
 * Only runs on connection transitions, not every render.
 */
export function useOfflineAutoNav(
  connStatus: ConnStatus | string,
  ctx: OfflineAutoNavContext,
  location: Pick<Location, 'pathname' | 'search' | 'state'>,
  navigate: NavigateFunction,
): void {
  const prevConnStatus = useRef(connStatus);
  useEffect(() => {
    const prev = prevConnStatus.current;
    prevConnStatus.current = connStatus;

    if (connStatus !== 'disconnected' || prev === 'disconnected') return;

    const action = resolveOfflineDisconnectNavAction(
      location.pathname,
      ctx.favoritesOfflineBrowse,
      ctx.localLibraryBrowse,
      ctx.playerStatsBrowse,
      ctx.playlistsOfflineBrowse,
      ctx.hasManualOfflineContent,
    );

    if (action.kind === 'stay') return;

    if (action.kind === 'stay-reload') {
      navigate(
        { pathname: location.pathname, search: location.search },
        {
          replace: true,
          state: {
            ...(typeof location.state === 'object' && location.state != null
              ? location.state as Record<string, unknown>
              : {}),
            offlineBrowseReloadTs: Date.now(),
          },
        },
      );
      return;
    }

    navigate(action.to, { replace: true });
  }, [
    connStatus,
    ctx.favoritesOfflineBrowse,
    ctx.localLibraryBrowse,
    ctx.playerStatsBrowse,
    ctx.playlistsOfflineBrowse,
    ctx.hasManualOfflineContent,
    location.pathname,
    location.search,
    location.state,
    navigate,
  ]);
}
