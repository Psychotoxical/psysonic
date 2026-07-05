/**
 * Waveform seekbar feature — the canvas seekbar (rendering only). Co-located
 * mirror of `cover/` / `music-network/`.
 *
 * The waveform DATA pipeline is audio-core, NOT this feature: the audio engine
 * calls it on track change to write `waveformBins` into the player store. It
 * therefore lives in core, consumed directly (never via this barrel):
 *   - `@/store/waveformRefresh` — `refreshWaveformForTrack` / `fetchWaveformBins`
 *   - `@/store/waveformRefreshGen` — `bumpWaveformRefreshGen` / `getWaveformRefreshGen`
 *   - `@/utils/waveform/waveformParse` — bin coercion (alongside `waveformSilence`,
 *     the crossfade / auto-dj silence helper)
 * Keeping these in core preserves the iron rule (no core→feature inversion).
 */
export { default as WaveformSeek } from './components/WaveformSeek';
export { SeekbarPreview } from './components/WaveformSeekPreview';
