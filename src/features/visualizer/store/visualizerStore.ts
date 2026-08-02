import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  VISUALIZER_MODES,
  type VisualizerMode,
} from '@/features/visualizer/utils/visualizerRenderers';

/** Emit rates offered in settings. Rust clamps to 10..90 regardless. */
export const VISUALIZER_FPS_OPTIONS = [30, 45, 60] as const;

export const MIN_SENSITIVITY = 0.6;
export const MAX_SENSITIVITY = 2.4;

/** Envelope responsiveness, 0 (long smooth tails) to 1 (snappy). Matches
 *  `DEFAULT_RESPONSIVENESS` in the Rust `spectrum_dsp` module. */
export const DEFAULT_RESPONSIVENESS = 0.65;

/** Identifies which surface (if any) is currently expanded to fill the window. */
export type VisualizerSurface = 'nowPlaying' | 'fullscreen';

/** Where the visualizer's colours come from. */
export type VisualizerColorSource = 'album' | 'theme';

export const VISUALIZER_COLOR_SOURCES: VisualizerColorSource[] = ['album', 'theme'];

export function clampSensitivity(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.max(MIN_SENSITIVITY, Math.min(MAX_SENSITIVITY, v));
}

export function clampResponsiveness(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_RESPONSIVENESS;
  return Math.max(0, Math.min(1, v));
}

export function clampFps(v: number): number {
  if (!Number.isFinite(v)) return 60;
  return Math.max(10, Math.min(90, Math.round(v)));
}

interface VisualizerState {
  /** Master switch. Off means no surface mounts and Rust never runs the FFT. */
  enabled: boolean;
  mode: VisualizerMode;
  /** Gamma on band levels; 1 is neutral. */
  sensitivity: number;
  /** How fast the bars fall, 0 (smooth) to 1 (snappy). Applied in Rust. */
  responsiveness: number;
  /** Requested emit rate. */
  fps: number;
  /** Winamp-style falling peak caps. */
  showPeaks: boolean;
  /** Cover art colours, or the active theme's accent ramp. */
  colorSource: VisualizerColorSource;

  /**
   * Which surface is expanded to fill the window. Runtime-only — an expanded
   * visualizer should never survive a restart and strand the user on a
   * full-window canvas.
   */
  expandedSurface: VisualizerSurface | null;

  setEnabled: (v: boolean) => void;
  setMode: (mode: VisualizerMode) => void;
  cycleMode: () => void;
  setSensitivity: (v: number) => void;
  setResponsiveness: (v: number) => void;
  setFps: (v: number) => void;
  setShowPeaks: (v: boolean) => void;
  setColorSource: (v: VisualizerColorSource) => void;
  setExpandedSurface: (surface: VisualizerSurface | null) => void;
  toggleExpanded: (surface: VisualizerSurface) => void;
}

export const useVisualizerStore = create<VisualizerState>()(
  persist(
    (set) => ({
      enabled: true,
      mode: 'bars',
      sensitivity: 1,
      responsiveness: DEFAULT_RESPONSIVENESS,
      fps: 60,
      showPeaks: true,
      colorSource: 'album',
      expandedSurface: null,

      setEnabled: (v) => set((s) => ({
        enabled: v,
        // Leaving the expanded state set while disabling would keep an empty
        // overlay pinned over the app.
        expandedSurface: v ? s.expandedSurface : null,
      })),
      setMode: (mode) => set({ mode }),
      cycleMode: () => set((s) => {
        const i = VISUALIZER_MODES.indexOf(s.mode);
        return { mode: VISUALIZER_MODES[(i + 1) % VISUALIZER_MODES.length] ?? 'bars' };
      }),
      setSensitivity: (v) => set({ sensitivity: clampSensitivity(v) }),
      setResponsiveness: (v) => set({ responsiveness: clampResponsiveness(v) }),
      setFps: (v) => set({ fps: clampFps(v) }),
      setShowPeaks: (v) => set({ showPeaks: v }),
      setColorSource: (v) => set({ colorSource: v }),
      setExpandedSurface: (surface) => set({ expandedSurface: surface }),
      toggleExpanded: (surface) => set((s) => ({
        expandedSurface: s.expandedSurface === surface ? null : surface,
      })),
    }),
    {
      name: 'psysonic_visualizer',
      partialize: (s) => ({
        enabled: s.enabled,
        mode: s.mode,
        sensitivity: s.sensitivity,
        responsiveness: s.responsiveness,
        fps: s.fps,
        showPeaks: s.showPeaks,
        colorSource: s.colorSource,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Persisted values come from disk and may predate a range change.
        state.sensitivity = clampSensitivity(state.sensitivity);
        state.responsiveness = clampResponsiveness(state.responsiveness);
        state.fps = clampFps(state.fps);
        // `waterfall` was replaced by the two-sided `stereo` view; move anyone
        // parked on it across rather than silently resetting them to bars.
        if ((state.mode as string) === 'waterfall') state.mode = 'stereo';
        if (!VISUALIZER_MODES.includes(state.mode)) state.mode = 'bars';
        // Migration: `colorSource` replaced a `useAlbumColors` boolean. Honour
        // an existing opt-out instead of silently switching those installs back
        // to cover colours.
        const legacy = (state as unknown as { useAlbumColors?: boolean }).useAlbumColors;
        if (!VISUALIZER_COLOR_SOURCES.includes(state.colorSource)) {
          state.colorSource = legacy === false ? 'theme' : 'album';
        }
        delete (state as unknown as { useAlbumColors?: boolean }).useAlbumColors;
        state.expandedSurface = null;
      },
    },
  ),
);
