import { showToast } from '../utils/toast';
import { usePlayerStore } from './playerStore';

/**
 * Internet radio streams play through a native HTMLAudioElement rather
 * than the Rust/Symphonia engine — the browser handles reconnect logic,
 * codec negotiation (MP3, AAC, HE-AAC, OGG), and ICY headers for free.
 *
 * This module owns:
 *  - the singleton `<audio>` element used for radio
 *  - the bounded stalled-reconnect retry loop (MAX_RADIO_RECONNECTS)
 *  - the suppression flag (`radioStopping`) that stops the error
 *    listener from clobbering store state when the caller asked for a
 *    clean stop
 *
 * Callers drive playback through `playRadioStream` / `pauseRadio` /
 * `resumeRadio` / `stopRadio` / `setRadioVolume`. The event listeners
 * write the store state directly when the browser decides the stream
 * is dead (ended / error / unrecoverable stall).
 */

const radioAudio = new Audio();
radioAudio.preload = 'none';

let radioStopping = false;
let radioReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let radioReconnectCount = 0;
const MAX_RADIO_RECONNECTS = 5;
const RECONNECT_DELAY_MS = 4000;

export function clearRadioReconnectTimer(): void {
  if (radioReconnectTimer) { clearTimeout(radioReconnectTimer); radioReconnectTimer = null; }
}

radioAudio.addEventListener('ended', () => {
  // Stream disconnected unexpectedly — clear radio state.
  clearRadioReconnectTimer();
  radioReconnectCount = 0;
  usePlayerStore.setState({ isPlaying: false, currentRadio: null, progress: 0, currentTime: 0 });
});
radioAudio.addEventListener('error', () => {
  clearRadioReconnectTimer();
  if (radioStopping) { radioStopping = false; radioReconnectCount = 0; return; }
  radioReconnectCount = 0;
  usePlayerStore.setState({ isPlaying: false, currentRadio: null });
  showToast('Radio stream error', 3000, 'error');
});
// Playing: stream is delivering audio — reset the reconnect counter.
radioAudio.addEventListener('playing', () => {
  radioReconnectCount = 0;
});
// Stalled: stream stopped delivering data — try to reconnect after 4 s.
// On macOS/WKWebView, reassigning src during a stall can itself trigger
// another stall event before the new connection is established.  The
// radioReconnectTimer guard prevents stacking, and MAX_RADIO_RECONNECTS
// ensures we don't loop forever on a dead stream.
radioAudio.addEventListener('stalled', () => {
  if (radioReconnectTimer) return; // already scheduled
  if (radioReconnectCount >= MAX_RADIO_RECONNECTS) {
    radioReconnectCount = 0;
    usePlayerStore.setState({ isPlaying: false, currentRadio: null });
    showToast('Radio stream disconnected', 4000, 'error');
    return;
  }
  radioReconnectTimer = setTimeout(() => {
    radioReconnectTimer = null;
    if (!usePlayerStore.getState().currentRadio) return;
    radioReconnectCount++;
    // Use load() + play() instead of src reassignment — more reliable on
    // macOS WKWebView where setting src can fire a premature error event.
    radioAudio.load();
    radioAudio.play().catch(console.error);
  }, RECONNECT_DELAY_MS);
});
// Waiting: browser is rebuffering — normal for live streams, no action needed.
radioAudio.addEventListener('waiting', () => {
  console.debug('[psysonic] radio: buffering');
});
// Suspend: browser paused loading (sufficient buffer) — cancel any stale reconnect.
radioAudio.addEventListener('suspend', () => {
  clearRadioReconnectTimer();
});

/**
 * Start a new stream. Resets the reconnect counter, sets src + volume,
 * and fires play. The returned promise rejects with the audio-element's
 * error so callers can surface it (the runtime currently uses this to
 * show a toast and clear `currentRadio` state).
 */
export function playRadioStream(streamUrl: string, volume: number): Promise<void> {
  radioReconnectCount = 0;
  radioAudio.src = streamUrl;
  radioAudio.volume = Math.max(0, Math.min(1, volume));
  return radioAudio.play();
}

/** Soft pause — keeps the src loaded so resume can pick up cheaply. */
export function pauseRadio(): void {
  radioAudio.pause();
}

/** Soft resume — re-plays the loaded src without reconnect. */
export function resumeRadio(): Promise<void> {
  return radioAudio.play();
}

/**
 * Full stop. Marks the next 'error' event as expected (so the listener
 * doesn't show an error toast), pauses, and clears the src so the
 * browser releases the underlying network resources.
 */
export function stopRadio(): void {
  radioStopping = true;
  radioAudio.pause();
  radioAudio.src = '';
  clearRadioReconnectTimer();
  radioReconnectCount = 0;
}

export function setRadioVolume(volume: number): void {
  radioAudio.volume = Math.max(0, Math.min(1, volume));
}

/** Test-only access to the underlying audio element + reset hook. */
export function _radioAudioForTest(): HTMLAudioElement {
  return radioAudio;
}

export function _resetRadioPlayerForTest(): void {
  radioStopping = false;
  radioReconnectCount = 0;
  clearRadioReconnectTimer();
  radioAudio.pause();
  radioAudio.src = '';
}
