import {
  PERF_LIVE_POLL_MS_MAX,
  PERF_LIVE_POLL_MS_MIN,
  PERF_LIVE_POLL_MS_STEP,
  setPerfLivePollIntervalMs,
  usePerfLivePollIntervalMs,
} from '../../../utils/perf/perfLivePollSettings';

export default function PerfLivePollControls() {
  const pollMs = usePerfLivePollIntervalMs();
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
    </section>
  );
}
