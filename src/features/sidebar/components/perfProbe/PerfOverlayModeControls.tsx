import {
  PERF_OVERLAY_MODE_OPTIONS,
  setPerfOverlayMode,
  usePerfOverlayMode,
} from '@/lib/perf/perfOverlayMode';

export default function PerfOverlayModeControls() {
  const mode = usePerfOverlayMode();

  return (
    <section className="perf-overlay-mode" aria-label="Overlay mode">
      <div className="perf-overlay-mode__title">On-screen overlay</div>
      <div className="perf-overlay-mode__segments" role="group" aria-label="Overlay mode">
        {PERF_OVERLAY_MODE_OPTIONS.map(option => (
          <button
            key={option.id}
            type="button"
            className={`perf-overlay-mode__segment${mode === option.id ? ' perf-overlay-mode__segment--active' : ''}`}
            aria-pressed={mode === option.id}
            onClick={() => setPerfOverlayMode(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="perf-overlay-mode__hint">
        {mode === 'off' && 'Overlay hidden.'}
        {mode === 'fps' && 'Shows only the FPS counter.'}
        {mode === 'pinned' && 'Shows metrics pinned in Monitor (pipeline + live).'}
      </p>
    </section>
  );
}
