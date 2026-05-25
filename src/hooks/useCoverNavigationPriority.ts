import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import {
  coverTrafficBeginNavigation,
  coverTrafficEndNavigation,
} from '../cover/coverTraffic';

/**
 * While the route changes, pause library backfill and background ensure so
 * visible grid covers and page paint stay responsive.
 */
export function useCoverNavigationPriority(): void {
  const { pathname } = useLocation();

  useEffect(() => {
    coverTrafficBeginNavigation();
    coverTrafficEndNavigation();
    return () => {
      coverTrafficBeginNavigation();
    };
  }, [pathname]);
}
