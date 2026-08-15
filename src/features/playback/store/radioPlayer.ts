import { showToast } from '@/lib/dom/toast';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useEqStore } from '@/store/eqStore';
import {
  applyRadioEqSettings,
  applyRadioOutputVolume,
  isRadioEqGraphActive,
  resumeRadioEqContext,
  setRadioEqMasterVolume,
  shouldUseRadioEqGraph,
  tryAttachRadioEqGraph,
  warmRadioEqContextFromUserGesture,
} from '@/features/playback/utils/audio/radioEqGraph';

/**
 * Internet radio streams play through a native HTMLAudioElement — the browser
 * handles reconnect logic, codec negotiation (AAC, HE-AAC, HLS), and ICY headers.
 *
 * When EQ is enabled and Web Audio attaches successfully, a 10-band peaking
 * chain is inserted via `createMediaElementSource` (issue #1276). EQ toggles
 * and preset changes update filter nodes in place — the stream is not restarted.
 * With EQ off the element keeps its native output path (no graph hijack).
 */

const radioAudio = new Audio();
radioAudio.preload = 'none';

let suppressHtml5RadioErrors = false;
/** True between `play()` and the first `playing` event for the current load. */
let radioAwaitingFirstFrame = false;
let radioStopping = false;
let radioReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let radioReconnectCount = 0;
let lastVolume = 1;
let transportGain = 1;
let radioFadeGeneration = 0;
let radioFadeTimer: ReturnType<typeof setInterval> | null = null;
let radioGraphActive = false;
let eqAttachUnsub: (() => void) | null = null;

const MEDIA_ERR_ABORTED = typeof MediaError !== 'undefined' ? MediaError.MEDIA_ERR_ABORTED : 1;
const MAX_RADIO_RECONNECTS = 5;
const RECONNECT_DELAY_MS = 4000;

function clampElementVolume(volume: number): number {
  return Math.max(0, Math.min(1, volume));
}

function applyEffectiveOutputVolume(): void {
  const volume = lastVolume * transportGain;
  applyRadioOutputVolume(volume, radioGraphActive);
  if (radioGraphActive && isRadioEqGraphActive()) {
    radioAudio.volume = 1;
    return;
  }
  radioAudio.volume = clampElementVolume(volume);
}

function applyOutputVolume(volume: number): void {
  lastVolume = volume;
  applyEffectiveOutputVolume();
}

function setTransportGain(gain: number): void {
  transportGain = clampElementVolume(gain);
  applyEffectiveOutputVolume();
}

function beginRadioFade(): number {
  radioFadeGeneration += 1;
  if (radioFadeTimer) {
    clearInterval(radioFadeTimer);
    radioFadeTimer = null;
  }
  return radioFadeGeneration;
}

function fadeTransportGain(
  generation: number,
  to: number,
  durationSecs: number,
  onComplete?: () => void,
): void {
  const from = transportGain;
  const durationMs = Math.max(100, Math.min(2000, durationSecs * 1000));
  const steps = Math.max(1, Math.round(durationMs / 20));
  let step = 0;
  const timer = setInterval(() => {
    if (generation !== radioFadeGeneration) {
      clearInterval(timer);
      if (radioFadeTimer === timer) radioFadeTimer = null;
      return;
    }
    step += 1;
    const t = Math.min(1, step / steps);
    const eased = t * t * (3 - 2 * t);
    setTransportGain(from + (to - from) * eased);
    if (step >= steps) {
      clearInterval(timer);
      if (radioFadeTimer === timer) radioFadeTimer = null;
      onComplete?.();
    }
  }, 20);
  radioFadeTimer = timer;
}

export function clearRadioReconnectTimer(): void {
  if (radioReconnectTimer) { clearTimeout(radioReconnectTimer); radioReconnectTimer = null; }
}

/** Call synchronously from a user-gesture handler before any `await` in `playRadio`. */
export function prepareRadioPlaybackFromUserGesture(): void {
  warmRadioEqContextFromUserGesture();
}

radioAudio.addEventListener('ended', () => {
  clearRadioReconnectTimer();
  radioReconnectCount = 0;
  usePlayerStore.setState({ isPlaying: false, currentRadio: null, progress: 0, currentTime: 0 });
});
radioAudio.addEventListener('error', () => {
  clearRadioReconnectTimer();
  if (radioStopping) {
    radioStopping = false;
    suppressHtml5RadioErrors = false;
    radioAwaitingFirstFrame = false;
    return;
  }
  const aborted = radioAudio.error?.code === MEDIA_ERR_ABORTED;
  if (suppressHtml5RadioErrors && (aborted || !radioAwaitingFirstFrame)) {
    suppressHtml5RadioErrors = false;
    return;
  }
  suppressHtml5RadioErrors = false;
  radioAwaitingFirstFrame = false;
  radioReconnectCount = 0;
  usePlayerStore.setState({ isPlaying: false, currentRadio: null });
  showToast('Radio stream error', 3000, 'error');
});
radioAudio.addEventListener('playing', () => {
  suppressHtml5RadioErrors = false;
  radioAwaitingFirstFrame = false;
  radioReconnectCount = 0;
  void resumeRadioEqContext();
});
radioAudio.addEventListener('stalled', () => {
  if (radioReconnectTimer) return;
  if (radioAudio.paused) return;
  if (radioReconnectCount >= MAX_RADIO_RECONNECTS) {
    radioReconnectCount = 0;
    usePlayerStore.setState({ isPlaying: false, currentRadio: null });
    showToast('Radio stream disconnected', 4000, 'error');
    return;
  }
  radioReconnectTimer = setTimeout(() => {
    radioReconnectTimer = null;
    if (!usePlayerStore.getState().currentRadio) return;
    if (radioAudio.paused) return;
    radioReconnectCount++;
    radioAudio.load();
    radioAudio.play().catch(console.error);
  }, RECONNECT_DELAY_MS);
});
radioAudio.addEventListener('waiting', () => {
  console.debug('[psysonic] radio: buffering');
});
radioAudio.addEventListener('suspend', () => {
  clearRadioReconnectTimer();
});

async function maybeAttachEqGraph(): Promise<boolean> {
  if (isRadioEqGraphActive()) {
    radioGraphActive = true;
    await resumeRadioEqContext().catch(() => {});
    return true;
  }
  if (!shouldUseRadioEqGraph() || radioGraphActive) return false;
  radioGraphActive = await tryAttachRadioEqGraph(radioAudio);
  if (!radioGraphActive) {
    radioAudio.removeAttribute('crossorigin');
    console.warn('[psysonic] radio EQ unavailable — playing without Web Audio graph');
  }
  return radioGraphActive;
}

export async function playRadioStream(streamUrl: string, volume: number): Promise<void> {
  beginRadioFade();
  transportGain = 1;
  radioReconnectCount = 0;
  radioGraphActive = isRadioEqGraphActive();

  suppressHtml5RadioErrors = true;
  radioAwaitingFirstFrame = true;
  if (shouldUseRadioEqGraph() || isRadioEqGraphActive()) {
    radioAudio.crossOrigin = 'anonymous';
  } else {
    radioAudio.removeAttribute('crossorigin');
  }
  radioAudio.src = streamUrl;

  if (shouldUseRadioEqGraph()) {
    await maybeAttachEqGraph();
  }
  applyOutputVolume(volume);
  if (radioGraphActive) {
    await resumeRadioEqContext().catch(() => {});
  }
  try {
    await radioAudio.play();
  } catch (err) {
    radioAwaitingFirstFrame = false;
    suppressHtml5RadioErrors = false;
    throw err;
  }
}

export function pauseRadio(fadeSecs = 0): void {
  clearRadioReconnectTimer();
  const generation = beginRadioFade();
  if (fadeSecs <= 0) {
    radioAudio.pause();
    return;
  }
  fadeTransportGain(generation, 0, fadeSecs, () => radioAudio.pause());
}

export async function resumeRadio(fadeSecs = 0): Promise<void> {
  const generation = beginRadioFade();
  warmRadioEqContextFromUserGesture();
  if (usePlayerStore.getState().currentRadio && shouldUseRadioEqGraph()) {
    await maybeAttachEqGraph();
    if (radioGraphActive) applyOutputVolume(lastVolume);
  }
  await resumeRadioEqContext().catch(() => {});
  if (generation !== radioFadeGeneration) return;
  if (fadeSecs > 0 && radioAudio.paused) setTransportGain(0);
  await radioAudio.play();
  if (generation !== radioFadeGeneration) return;
  if (fadeSecs > 0) fadeTransportGain(generation, 1, fadeSecs);
  else setTransportGain(1);
}

export function stopRadio(): void {
  beginRadioFade();
  transportGain = 1;
  radioStopping = true;
  radioAudio.pause();
  radioAudio.src = '';
  radioAudio.removeAttribute('crossorigin');
  radioGraphActive = false;
  radioAwaitingFirstFrame = false;
  clearRadioReconnectTimer();
  radioReconnectCount = 0;
}

export function setRadioVolume(volume: number): void {
  applyOutputVolume(volume);
}

/**
 * When EQ is enabled during an active radio session, attach the Web Audio graph
 * in place (no stream restart). Filter updates are handled by `bindRadioEqStore`.
 */
export function bindRadioEqAttachOnEnable(): () => void {
  if (eqAttachUnsub) {
    return () => {
      eqAttachUnsub?.();
      eqAttachUnsub = null;
    };
  }
  eqAttachUnsub = useEqStore.subscribe((state, prev) => {
    if (!state.enabled || prev.enabled) return;
    const player = usePlayerStore.getState();
    if (!player.currentRadio || radioGraphActive) return;
    radioAudio.crossOrigin = 'anonymous';
    void maybeAttachEqGraph().then(() => {
      if (radioGraphActive) {
        applyOutputVolume(lastVolume);
        const { gains, enabled, preGain } = useEqStore.getState();
        applyRadioEqSettings(gains, enabled, preGain);
      }
    });
  });
  return () => {
    eqAttachUnsub?.();
    eqAttachUnsub = null;
  };
}

export function _radioAudioForTest(): HTMLAudioElement {
  return radioAudio;
}

export function _resetRadioPlayerForTest(): void {
  radioStopping = false;
  suppressHtml5RadioErrors = false;
  radioAwaitingFirstFrame = false;
  radioReconnectCount = 0;
  radioGraphActive = false;
  lastVolume = 1;
  transportGain = 1;
  beginRadioFade();
  clearRadioReconnectTimer();
  radioAudio.pause();
  radioAudio.src = '';
  radioAudio.removeAttribute('crossorigin');
  setRadioEqMasterVolume(1);
}

export function _radioGraphActiveForTest(): boolean {
  return radioGraphActive;
}
