import { useEffect, useRef } from 'react';
import type { NavigateFunction } from 'react-router-dom';

type ConnStatus = 'connected' | 'disconnected' | 'connecting' | 'unknown';

/**
 * Auto-route the user between the offline library and main pages based on
 * connection status:
 *  - Disconnect with cached content → push `/offline`.
 *  - Reconnect while sitting on `/offline` → push back to `/`.
 *
 * Only fires on transitions (not on every render). Reconnect-bounce is
 * gated on `prev === 'disconnected'` so a user who navigates to `/offline`
 * manually while online stays there.
 */
export function useOfflineAutoNav(
  connStatus: ConnStatus | string,
  hasOfflineContent: boolean,
  pathname: string,
  navigate: NavigateFunction,
): void {
  const prevConnStatus = useRef(connStatus);
  useEffect(() => {
    const prev = prevConnStatus.current;
    prevConnStatus.current = connStatus;

    if (connStatus === 'disconnected' && hasOfflineContent && prev !== 'disconnected') {
      navigate('/offline', { replace: true });
    }
    if (connStatus === 'connected' && prev === 'disconnected' && pathname === '/offline') {
      navigate('/', { replace: true });
    }
  }, [connStatus, hasOfflineContent, pathname, navigate]);
}
