import {
  PERF_OVERLAY_CORNER_OPTIONS,
  setPerfOverlayCorner,
  setPerfOverlayOpacity,
  usePerfOverlayAppearance,
} from '@/lib/perf/perfOverlayAppearance';

export default function PerfOverlayAppearanceControls() {
  const { corner, opacity } = usePerfOverlayAppearance();

  return (
    <section className="perf-overlay-appearance" aria-label="Overlay layout">
      <div className="perf-overlay-appearance__title">Layout</div>
      <div className="perf-overlay-appearance__row">
        <span className="perf-overlay-appearance__label">Corner</span>
        <div className="perf-overlay-appearance__corners" role="group" aria-label="Overlay corner">
          {PERF_OVERLAY_CORNER_OPTIONS.map(opt => (
            <button
              key={opt.id}
              type="button"
              className={`perf-overlay-appearance__corner${corner === opt.id ? ' perf-overlay-appearance__corner--active' : ''}`}
              aria-pressed={corner === opt.id}
              onClick={() => setPerfOverlayCorner(opt.id)}
              title={opt.label}
            >
              <span className={`perf-overlay-appearance__corner-mark perf-overlay-appearance__corner-mark--${opt.id}`} />
            </button>
          ))}
        </div>
      </div>
      <label className="perf-overlay-appearance__row perf-overlay-appearance__opacity">
        <span className="perf-overlay-appearance__label">
          Opacity
          {' '}
          <span className="perf-overlay-appearance__value">{Math.round(opacity * 100)}%</span>
        </span>
        <input
          type="range"
          min={25}
          max={100}
          step={5}
          value={Math.round(opacity * 100)}
          onChange={e => setPerfOverlayOpacity(Number(e.target.value) / 100)}
        />
      </label>
    </section>
  );
}
