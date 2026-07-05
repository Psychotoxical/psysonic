/**
 * Equalizer feature — the graphic EQ panel (band faders, preset picker, EQ
 * curve canvas) plus the auto-EQ section and its hook. Mounted from the
 * settings audio tab and the player bar.
 *
 * Stays OUT (audio-core global state, consumed by the playback engine, not
 * owned): `store/eqStore` (drives the audio graph; read by `eqDeviceSync` /
 * `eqCurve` in the playback core) and the `eqCurve` renderer.
 */
export { default as Equalizer } from './components/Equalizer';
