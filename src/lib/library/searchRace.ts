/**
 * Parallel local vs network search — first successful backend wins.
 */

import type { SearchResults } from '@/lib/api/subsonicTypes';

export type SearchRaceSource = 'local' | 'network';

export interface SearchRaceWinner<T> {
  source: SearchRaceSource;
  result: T;
  durationMs: number;
}

export interface SearchRaceRunner<T> {
  source: SearchRaceSource;
  run: () => Promise<T | null>;
}

/**
 * Run search backends in parallel. The first non-null result wins; one runner
 * failing does not reject until every runner has failed or returned null.
 */
export async function raceSearchSources<T>(
  runners: SearchRaceRunner<T>[],
  isStale: () => boolean,
): Promise<SearchRaceWinner<T> | null> {
  if (runners.length === 0 || isStale()) return null;

  return new Promise((resolve, reject) => {
    let pending = runners.length;
    let settled = false;
    const errors: unknown[] = [];

    const onRunnerDone = () => {
      pending -= 1;
      if (!settled && pending === 0) {
        if (errors.length > 0) reject(errors[0]);
        else resolve(null);
      }
    };

    for (const { source, run } of runners) {
      const t0 = performance.now();
      void run()
        .then(result => {
          if (settled) return;
          if (isStale()) {
            onRunnerDone();
            return;
          }
          if (result != null) {
            settled = true;
            resolve({
              source,
              result,
              durationMs: Math.round(performance.now() - t0),
            });
            return;
          }
          onRunnerDone();
        })
        .catch(err => {
          if (settled) return;
          if (isStale()) {
            onRunnerDone();
            return;
          }
          errors.push(err);
          onRunnerDone();
        });
    }
  });
}

export function searchResultsHaveHits(results: SearchResults): boolean {
  return results.artists.length > 0 || results.albums.length > 0 || results.songs.length > 0;
}

export interface LiveSearchRaceSettled {
  winner: SearchRaceSource;
  localMs: number;
  networkMs: number;
  localHits: string;
  networkHits: string;
  localResult: SearchResults | null;
  networkResult: SearchResults | null;
}

function hitCounts(r: SearchResults): string {
  return `${r.artists.length}/${r.albums.length}/${r.songs.length}`;
}

function emptySearchResults(): SearchResults {
  return { artists: [], albums: [], songs: [] };
}

function resultOrEmpty(result: SearchResults | null): SearchResults {
  return result ?? emptySearchResults();
}

/**
 * Live Search race: first backend with hits wins; empty waits for the other.
 * `onSettled` fires when both runners finish and includes both payloads for merge.
 */
export async function raceLiveSearch(
  localRun: () => Promise<SearchResults | null>,
  networkRun: () => Promise<SearchResults | null>,
  isStale: () => boolean,
  onSettled?: (meta: LiveSearchRaceSettled) => void,
): Promise<SearchRaceWinner<SearchResults> | null> {
  if (isStale()) return null;

  return new Promise((resolve, reject) => {
    let settled = false;
    let resolvedWinner: SearchRaceSource | null = null;
    let localResult: SearchResults | null = null;
    let networkResult: SearchResults | null = null;
    let localDone = false;
    let networkDone = false;
    let localMs = 0;
    let networkMs = 0;
    let raceNotified = false;
    const errors: unknown[] = [];

    const notifySettled = () => {
      if (raceNotified || !localDone || !networkDone || !onSettled) return;
      raceNotified = true;
      const local = resultOrEmpty(localResult);
      const network = resultOrEmpty(networkResult);
      const winner =
        resolvedWinner ??
        (searchResultsHaveHits(network)
          ? 'network'
          : searchResultsHaveHits(local)
            ? 'local'
            : networkResult
              ? 'network'
              : 'local');
      onSettled({
        winner,
        localMs,
        networkMs,
        localHits: hitCounts(local),
        networkHits: hitCounts(network),
        localResult,
        networkResult,
      });
    };

    const resolveWinner = (source: SearchRaceSource, result: SearchResults, durationMs: number) => {
      settled = true;
      resolvedWinner = source;
      resolve({ source, result, durationMs });
    };

    const maybeFinish = () => {
      if (settled || isStale()) return;

      if (localDone && localResult && searchResultsHaveHits(localResult)) {
        resolveWinner('local', localResult, localMs);
        if (networkDone) notifySettled();
        return;
      }
      if (networkDone && networkResult && searchResultsHaveHits(networkResult)) {
        resolveWinner('network', networkResult, networkMs);
        if (localDone) notifySettled();
        return;
      }
      if (!localDone || !networkDone) return;

      settled = true;
      if (networkResult && searchResultsHaveHits(networkResult)) {
        resolvedWinner = 'network';
        resolve({ source: 'network', result: networkResult, durationMs: networkMs });
      } else if (localResult && searchResultsHaveHits(localResult)) {
        resolvedWinner = 'local';
        resolve({ source: 'local', result: localResult, durationMs: localMs });
      } else if (networkResult) {
        resolvedWinner = 'network';
        resolve({ source: 'network', result: networkResult, durationMs: networkMs });
      } else if (localResult) {
        resolvedWinner = 'local';
        resolve({ source: 'local', result: localResult, durationMs: localMs });
      } else if (errors.length > 0) {
        reject(errors[0]);
      } else {
        resolve(null);
      }
      notifySettled();
    };

    const localT0 = performance.now();
    void localRun()
      .then(result => {
        localMs = Math.round(performance.now() - localT0);
        localResult = result;
        localDone = true;
        maybeFinish();
        notifySettled();
      })
      .catch(err => {
        errors.push(err);
        localDone = true;
        maybeFinish();
        notifySettled();
      });

    const networkT0 = performance.now();
    void networkRun()
      .then(result => {
        networkMs = Math.round(performance.now() - networkT0);
        networkResult = result;
        networkDone = true;
        maybeFinish();
        notifySettled();
      })
      .catch(err => {
        const name = err instanceof Error ? err.name : '';
        if (name === 'CanceledError' || name === 'AbortError') {
          networkDone = true;
          maybeFinish();
          notifySettled();
          return;
        }
        errors.push(err);
        networkDone = true;
        maybeFinish();
        notifySettled();
      });
  });
}
