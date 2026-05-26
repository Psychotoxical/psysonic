import type { CoverCacheStrategy } from '../utils/library/coverStrategy';
import {
  coverStrategyAllowsLibraryBackfill,
  coverStrategyAllowsRoutePrefetch,
} from '../utils/library/coverStrategy';

/** @deprecated Use `coverStrategyAllowsRoutePrefetch` */
export function coverPrefetchStrategyAllowsRoutePrefetch(
  strategy: CoverCacheStrategy,
): boolean {
  return coverStrategyAllowsRoutePrefetch(strategy);
}

/** @deprecated Use `coverStrategyAllowsLibraryBackfill` */
export function coverPrefetchStrategyAllowsLibraryBackfill(
  strategy: CoverCacheStrategy,
): boolean {
  return coverStrategyAllowsLibraryBackfill(strategy);
}
