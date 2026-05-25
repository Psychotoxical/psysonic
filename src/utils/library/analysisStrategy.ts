export const ANALYTICS_STRATEGIES = ['lazy', 'advanced'] as const;

export type AnalyticsStrategy = (typeof ANALYTICS_STRATEGIES)[number];

export const DEFAULT_ANALYTICS_STRATEGY: AnalyticsStrategy = 'lazy';

export const ADVANCED_PARALLELISM_MIN = 1;
export const ADVANCED_PARALLELISM_MAX = 20;
export const DEFAULT_ADVANCED_PARALLELISM = 1;

export function clampAdvancedParallelism(value: number): number {
  const rounded = Math.round(value);
  return Math.min(
    ADVANCED_PARALLELISM_MAX,
    Math.max(ADVANCED_PARALLELISM_MIN, rounded),
  );
}
