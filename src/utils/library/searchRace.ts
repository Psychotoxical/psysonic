/**
 * Parallel local vs network search — first successful backend wins.
 */

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
