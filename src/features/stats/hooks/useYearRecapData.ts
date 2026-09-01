import { useEffect, useState } from 'react';
import {
  libraryGetPlayerStatsHeatmap,
  libraryGetPlayerStatsYearRecap,
  libraryGetPlayerStatsYearSummary,
  type PlaySessionHeatmapDay,
  type PlaySessionYearRecap,
  type PlaySessionYearSummary,
} from '@/lib/api/library';

export interface YearRecapData {
  year: number;
  recap: PlaySessionYearRecap;
  summary: PlaySessionYearSummary;
  heatmap: PlaySessionHeatmapDay[];
}

/**
 * Loads everything the recap story and poster need in one pass. `requestId`
 * gates the fetch (0 = never asked) so the panel can mount the hook without
 * paying for the queries until the user opens the recap — and bumping it
 * retries after a failed load, which a boolean gate could not express.
 */
export function useYearRecapData(year: number, requestId: number): {
  data: YearRecapData | null;
  loading: boolean;
  error: boolean;
} {
  const [data, setData] = useState<YearRecapData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (requestId === 0) return;
    if (data?.year === year) return;
    let cancelled = false;
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(false);
    Promise.all([
      libraryGetPlayerStatsYearRecap(year),
      libraryGetPlayerStatsYearSummary(year),
      libraryGetPlayerStatsHeatmap(year),
    ])
      .then(([recap, summary, heatmap]) => {
        if (cancelled) return;
        setData({ year, recap, summary, heatmap });
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [year, requestId, data?.year]);

  return { data: data?.year === year ? data : null, loading, error };
}
