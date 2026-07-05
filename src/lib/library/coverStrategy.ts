export const COVER_CACHE_STRATEGIES = ['lazy', 'aggressive'] as const;

export type CoverCacheStrategy = (typeof COVER_CACHE_STRATEGIES)[number];

export const DEFAULT_COVER_CACHE_STRATEGY: CoverCacheStrategy = 'lazy';

export function coverStrategyAllowsRoutePrefetch(_strategy: CoverCacheStrategy): boolean {
  return true;
}

export function coverStrategyAllowsLibraryBackfill(strategy: CoverCacheStrategy): boolean {
  return strategy === 'aggressive';
}

/** Map legacy auth-store `coverPrefetchStrategy` to per-server strategy. */
export function coverStrategyFromLegacyPrefetch(
  legacy: string | undefined,
): CoverCacheStrategy {
  if (legacy === 'library') return 'aggressive';
  return 'lazy';
}
