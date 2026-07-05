import { useEffect, useRef, useState } from 'react';
import {
  coverGetPipelineQueueStats,
  libraryCoverBackfillResetCursor,
  libraryCoverBackfillRunFullPass,
  libraryCoverBackfillSetParallel,
} from '@/lib/api/coverCache';

const COVER_THREADS_MIN = 1;
const COVER_THREADS_MAX = 16;

/**
 * PsyLab tuning knob for cover backfill concurrency (download + encode pools
 * move together). Deliberately not surfaced in app Settings — it is a live
 * diagnostics/experiment control. The value is process-local and resets to the
 * backend default on app restart.
 */
export default function PerfCoverThreadsControl() {
  const [threads, setThreads] = useState<number | null>(null);
  const pendingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void coverGetPipelineQueueStats()
      .then(stats => {
        if (!cancelled) setThreads(stats.libraryBackfillHttpMax || COVER_THREADS_MIN);
      })
      .catch(() => {
        if (!cancelled) setThreads(COVER_THREADS_MIN);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const apply = (next: number) => {
    setThreads(next);
    if (pendingRef.current) return;
    pendingRef.current = true;
    void libraryCoverBackfillSetParallel(next)
      .then(applied => setThreads(applied))
      .catch(() => {})
      .finally(() => {
        pendingRef.current = false;
      });
  };

  const value = threads ?? COVER_THREADS_MIN;
  const [running, setRunning] = useState(false);

  const runPass = () => {
    if (running) return;
    setRunning(true);
    void libraryCoverBackfillResetCursor()
      .then(() => libraryCoverBackfillRunFullPass(true))
      .catch(() => {})
      .finally(() => setRunning(false));
  };

  return (
    <section className="perf-live-poll" aria-label="Cover backfill threads">
      <div className="perf-live-poll__title">Cover backfill</div>
      <label className="perf-live-poll__row">
        <span className="perf-live-poll__label">
          Threads
          {' '}
          <span className="perf-live-poll__value">{value}</span>
        </span>
        <input
          type="range"
          min={COVER_THREADS_MIN}
          max={COVER_THREADS_MAX}
          step={1}
          value={value}
          disabled={threads === null}
          onChange={e => apply(Number(e.target.value))}
        />
      </label>
      <button
        type="button"
        className="perf-live-poll__run"
        onClick={runPass}
        disabled={running}
      >
        {running ? 'Starting…' : 'Run full pass now'}
      </button>
      <p className="perf-live-poll__hint">
        Download + encode concurrency for background cover warm-up. Higher = faster
        backfill but more CPU/network while it runs. Resets to default on restart.
        “lib …/N” in the cover overlay only fills when covers are actually missing —
        clear a server’s cover cache first, then run a pass.
      </p>
    </section>
  );
}
