import { useEffect, useRef } from 'react';
import type { NavigateFunction } from 'react-router-dom';

type ConnStatus = 'connected' | 'disconnected' | 'connecting' | 'unknown';

/**
 * Auto-route the user between offline-capable pages and main pages based on
 * connection status:
 *  - Disconnect with manual offline pins → push `/offline`.
 *  - Disconnect with favorites offline browse enabled → push `/favorites`.
 *  - Reconnect while sitting on `/offline` or `/favorites` → push back to `/`.
 *
 * Only fires on transitions (not on every render). Reconnect-bounce is
 * gated on `prev === 'disconnected'` so a user who navigates to `/offline`
 * manually while online stays there.
 */
export function useOfflineAutoNav(
  connStatus: ConnStatus | string,
  hasManualOfflineContent: boolean,
  favoritesOfflineBrowse: boolean,
  pathname: string,
  navigate: NavigateFunction,
): void {
  const prevConnStatus = useRef(connStatus);
  useEffect(() => {
    const prev = prevConnStatus.current;
    prevConnStatus.current = connStatus;

    if (connStatus === 'disconnected' && prev !== 'disconnected') {
      if (hasManualOfflineContent) {
        navigate('/offline', { replace: true });
      } else if (favoritesOfflineBrowse) {
        navigate('/favorites', { replace: true });
      }
    }
    if (
      connStatus === 'connected'
      && prev === 'disconnected'
      && (pathname === '/offline' || pathname === '/favorites')
    ) {
      navigate('/', { replace: true });
    }
  }, [
    connStatus,
    hasManualOfflineContent,
    favoritesOfflineBrowse,
    pathname,
    navigate,
  ]);
}
