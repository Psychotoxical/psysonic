import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import {
  coverTrafficBeginNavigation,
  coverTrafficEndNavigation,
} from '@/cover/coverTraffic';

/**
 * On route change: cancel queued peek/ensure/prefetch from the old page and
 * briefly pause library backfill so the new page can warm covers first.
 */
export function useCoverNavigationPriority(): void {
  const { pathname } = useLocation();

  useEffect(() => {
    coverTrafficBeginNavigation();
    coverTrafficEndNavigation();
    return () => {
      coverTrafficEndNavigation();
    };
  }, [pathname]);
}
