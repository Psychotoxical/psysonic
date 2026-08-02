import { beforeEach, describe, expect, it } from 'vitest';
import {
  clampFps,
  clampResponsiveness,
  clampSensitivity,
  DEFAULT_RESPONSIVENESS,
  MAX_SENSITIVITY,
  MIN_SENSITIVITY,
  useVisualizerStore,
} from './visualizerStore';

function reset(): void {
  useVisualizerStore.setState({
    enabled: true,
    mode: 'bars',
    sensitivity: 1,
    responsiveness: DEFAULT_RESPONSIVENESS,
    fps: 60,
    showPeaks: true,
    colorSource: 'album',
    expandedSurface: null,
  });
}

describe('clampSensitivity', () => {
  it('keeps in-range values', () => {
    expect(clampSensitivity(1.4)).toBe(1.4);
  });

  it('clamps to the supported range', () => {
    expect(clampSensitivity(-10)).toBe(MIN_SENSITIVITY);
    expect(clampSensitivity(99)).toBe(MAX_SENSITIVITY);
  });

  it('falls back to neutral for non-numbers', () => {
    expect(clampSensitivity(NaN)).toBe(1);
    expect(clampSensitivity(Infinity)).toBe(1);
  });
});

describe('clampResponsiveness', () => {
  it('keeps in-range values', () => {
    expect(clampResponsiveness(0.3)).toBe(0.3);
  });

  it('clamps to 0..1', () => {
    expect(clampResponsiveness(-2)).toBe(0);
    expect(clampResponsiveness(7)).toBe(1);
  });

  it('keeps the smoothest setting distinct from unset', () => {
    // 0 is a legitimate value, not "no preference".
    expect(clampResponsiveness(0)).toBe(0);
  });

  it('falls back to the default for non-numbers', () => {
    expect(clampResponsiveness(NaN)).toBe(DEFAULT_RESPONSIVENESS);
  });
});

describe('clampFps', () => {
  it('clamps to what Rust accepts', () => {
    expect(clampFps(1)).toBe(10);
    expect(clampFps(500)).toBe(90);
  });

  it('rounds to whole frames', () => {
    expect(clampFps(44.6)).toBe(45);
  });

  it('falls back to 60 for non-numbers', () => {
    expect(clampFps(NaN)).toBe(60);
  });
});

describe('visualizerStore', () => {
  beforeEach(reset);

  it('cycles through every mode and wraps around', () => {
    const { cycleMode } = useVisualizerStore.getState();
    cycleMode();
    expect(useVisualizerStore.getState().mode).toBe('scope');
    cycleMode();
    expect(useVisualizerStore.getState().mode).toBe('radial');
    cycleMode();
    expect(useVisualizerStore.getState().mode).toBe('stereo');
    cycleMode();
    expect(useVisualizerStore.getState().mode).toBe('bars');
  });

  it('clamps responsiveness through the setter', () => {
    const s = useVisualizerStore.getState();
    s.setResponsiveness(9);
    expect(useVisualizerStore.getState().responsiveness).toBe(1);
    s.setResponsiveness(-9);
    expect(useVisualizerStore.getState().responsiveness).toBe(0);
  });

  it('persists responsiveness', () => {
    const persisted = Object.keys(
      (useVisualizerStore.persist.getOptions().partialize?.(
        useVisualizerStore.getState(),
      ) ?? {}) as Record<string, unknown>,
    );
    expect(persisted).toContain('responsiveness');
  });

  it('clamps sensitivity and fps through the setters', () => {
    const s = useVisualizerStore.getState();
    s.setSensitivity(99);
    s.setFps(1);
    expect(useVisualizerStore.getState().sensitivity).toBe(MAX_SENSITIVITY);
    expect(useVisualizerStore.getState().fps).toBe(10);
  });

  it('toggles a surface open and closed', () => {
    const { toggleExpanded } = useVisualizerStore.getState();
    toggleExpanded('nowPlaying');
    expect(useVisualizerStore.getState().expandedSurface).toBe('nowPlaying');
    toggleExpanded('nowPlaying');
    expect(useVisualizerStore.getState().expandedSurface).toBeNull();
  });

  it('only ever expands one surface at a time', () => {
    const { toggleExpanded } = useVisualizerStore.getState();
    toggleExpanded('nowPlaying');
    toggleExpanded('fullscreen');
    expect(useVisualizerStore.getState().expandedSurface).toBe('fullscreen');
  });

  it('collapses when the visualizer is disabled', () => {
    const s = useVisualizerStore.getState();
    s.toggleExpanded('fullscreen');
    s.setEnabled(false);
    expect(useVisualizerStore.getState().expandedSurface).toBeNull();
  });

  it('keeps the expanded surface when re-enabling without one', () => {
    const s = useVisualizerStore.getState();
    s.setEnabled(false);
    s.setEnabled(true);
    expect(useVisualizerStore.getState().expandedSurface).toBeNull();
    expect(useVisualizerStore.getState().enabled).toBe(true);
  });

  it('does not persist the expanded surface', () => {
    // An expanded overlay surviving a restart would strand the user on a
    // full-window canvas with no obvious way back.
    const persisted = Object.keys(
      (useVisualizerStore.persist.getOptions().partialize?.(
        useVisualizerStore.getState(),
      ) ?? {}) as Record<string, unknown>,
    );
    expect(persisted).not.toContain('expandedSurface');
    expect(persisted).toContain('mode');
    expect(persisted).toContain('sensitivity');
  });
});
