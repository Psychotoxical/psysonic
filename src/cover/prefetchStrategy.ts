import type { CoverCacheStrategy } from '@/lib/library/coverStrategy';
import {
  coverStrategyAllowsLibraryBackfill,
  coverStrategyAllowsRoutePrefetch,
} from '@/lib/library/coverStrategy';

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
