/**
 * Visualizer feature — Winamp-style spectrum/oscilloscope animation driven by
 * the audio actually being played.
 *
 * Data comes from the audio engine, not this feature: Rust taps the rodio
 * source chain post-EQ, runs the FFT off the audio thread and emits
 * `audio:spectrum` (see `src-tauri/crates/psysonic-audio/src/spectrum.rs`).
 * Internet radio, which plays through an `HTMLAudioElement`, is read from a
 * Web Audio `AnalyserNode` instead — both feeds land in the same frame shape.
 *
 * Cross-feature consumers mount `VisualizerPanel` and nothing else; the canvas,
 * feed hook and renderers are internal.
 */
export { default as VisualizerPanel } from './components/VisualizerPanel';
export {
  useVisualizerStore,
  VISUALIZER_FPS_OPTIONS,
  MIN_SENSITIVITY,
  MAX_SENSITIVITY,
  DEFAULT_RESPONSIVENESS,
} from './store/visualizerStore';
export type { VisualizerColorSource, VisualizerSurface } from './store/visualizerStore';
export type { VisualizerMode } from './utils/visualizerRenderers';
