import { perfLiveCpuSnapshotSupported } from '@/lib/perf/perfLiveCpuSnapshot';
import {
  PERF_LIVE_POLL_MS_MAX,
  PERF_LIVE_POLL_MS_MIN,
  PERF_LIVE_POLL_MS_STEP,
  setPerfLiveIncludeThreadGroups,
  setPerfLivePollIntervalMs,
  usePerfLiveIncludeThreadGroups,
  usePerfLivePollIntervalMs,
} from '@/lib/perf/perfLivePollSettings';

export default function PerfLivePollControls() {
  const pollMs = usePerfLivePollIntervalMs();
  const includeThreadGroups = usePerfLiveIncludeThreadGroups();
  if (!perfLiveCpuSnapshotSupported()) return null;

  const pollSec = (pollMs / 1000).toFixed(1);

  return (
    <section className="perf-live-poll" aria-label="Live poll interval">
      <div className="perf-live-poll__title">Live sampling</div>
      <label className="perf-live-poll__row">
        <span className="perf-live-poll__label">
          Poll interval
          {' '}
          <span className="perf-live-poll__value">{pollSec}s</span>
        </span>
        <input
          type="range"
          min={PERF_LIVE_POLL_MS_MIN}
          max={PERF_LIVE_POLL_MS_MAX}
          step={PERF_LIVE_POLL_MS_STEP}
          value={pollMs}
          onChange={e => setPerfLivePollIntervalMs(Number(e.target.value))}
        />
      </label>
      <label className="perf-live-poll__row perf-live-poll__row--check">
        <input
          type="checkbox"
          checked={includeThreadGroups}
          onChange={e => setPerfLiveIncludeThreadGroups(e.target.checked)}
        />
        <span className="perf-live-poll__check-label">
          CPU by psysonic threads
        </span>
      </label>
      <p className="perf-live-poll__hint">
        Scans in-process thread groups each poll (Linux). Off by default — enable only while diagnosing.
      </p>
    </section>
  );
}
