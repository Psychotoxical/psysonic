import { EQ_BANDS, useEqStore } from '@/store/eqStore';

/** Matches Rust `MASTER_HEADROOM` in psysonic-audio helpers. */
export const RADIO_MASTER_HEADROOM = 0.891_254;

const EQ_Q = 1.41;

type RadioEqGraph = {
  context: AudioContext;
  source: MediaElementAudioSourceNode;
  preGainNode: GainNode;
  bands: BiquadFilterNode[];
  masterGain: GainNode;
};

let graph: RadioEqGraph | null = null;
let sharedContext: AudioContext | null = null;
let pendingMasterVolume = 1;
let eqStoreUnsub: (() => void) | null = null;

function clampVolume(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

function clampBandGain(db: number): number {
  return Math.max(-12, Math.min(12, db));
}

function clampPreGainDb(db: number): number {
  return Math.max(-30, Math.min(6, db));
}

function clampCenterFreq(hz: number, sampleRate: number): number {
  return Math.max(20, Math.min(hz, sampleRate / 2 - 100));
}

function audioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  return window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    ?? null;
}

export function isRadioEqAvailable(): boolean {
  return audioContextCtor() != null;
}

export function isRadioEqGraphActive(): boolean {
  return graph != null;
}

function syncMasterGain(g: RadioEqGraph): void {
  g.masterGain.gain.value = clampVolume(pendingMasterVolume) * RADIO_MASTER_HEADROOM;
}

function applyEqToGraph(g: RadioEqGraph, gains: number[], enabled: boolean, preGainDb: number): void {
  const sampleRate = g.context.sampleRate;
  if (!enabled) {
    g.preGainNode.gain.value = 1;
    for (const band of g.bands) {
      band.gain.value = 0;
    }
    return;
  }
  g.preGainNode.gain.value = dbToLinear(clampPreGainDb(preGainDb));
  for (let i = 0; i < g.bands.length; i++) {
    const node = g.bands[i]!;
    node.frequency.value = clampCenterFreq(EQ_BANDS[i]!.freq, sampleRate);
    node.Q.value = EQ_Q;
    node.gain.value = clampBandGain(gains[i] ?? 0);
  }
}

function getOrCreateContext(): AudioContext | null {
  if (graph) return graph.context;
  if (sharedContext) return sharedContext;
  const Ctx = audioContextCtor();
  if (!Ctx) return null;
  try {
    sharedContext = new Ctx({ latencyHint: 'playback' });
    return sharedContext;
  } catch {
    return null;
  }
}

/**
 * Resume AudioContext synchronously from a user-gesture handler (before any
 * `await`) so WebKit/WebView2 allow playback through the graph later.
 */
export function warmRadioEqContextFromUserGesture(): void {
  const context = getOrCreateContext();
  if (!context) return;
  if (context.state === 'suspended') {
    void context.resume();
  }
}

export async function resumeRadioEqContext(): Promise<void> {
  if (graph?.context.state === 'suspended') {
    await graph.context.resume();
  }
}

/**
 * Wire Web Audio EQ for the radio `<audio>` element. Only call when EQ is
 * **enabled** — `createMediaElementSource` hijacks element output; on streams
 * without CORS that path is silent, so EQ-off keeps the native element path.
 *
 * Set `crossOrigin="anonymous"` on the element before assigning `src`.
 */
export async function tryAttachRadioEqGraph(audio: HTMLAudioElement): Promise<boolean> {
  // Element output is permanently hijacked once the graph exists — never report
  // "inactive" or callers fall back to element.volume (silent / wrong routing).
  if (graph) {
    syncMasterGain(graph);
    await resumeRadioEqContext().catch(() => {});
    return true;
  }

  const context = getOrCreateContext();
  if (!context) return false;

  try {
    await context.resume();
  } catch {
    return false;
  }
  if (context.state !== 'running') return false;

  audio.crossOrigin = 'anonymous';

  try {
    const preGainNode = context.createGain();
    const bands = EQ_BANDS.map((band) => {
      const node = context.createBiquadFilter();
      node.type = 'peaking';
      node.frequency.value = clampCenterFreq(band.freq, context.sampleRate);
      node.Q.value = EQ_Q;
      node.gain.value = 0;
      return node;
    });
    const masterGain = context.createGain();

    let tail: AudioNode = preGainNode;
    for (const band of bands) {
      tail.connect(band);
      tail = band;
    }
    tail.connect(masterGain);
    masterGain.connect(context.destination);

    // Create the source last — once it exists the element output is hijacked.
    const source = context.createMediaElementSource(audio);
    source.connect(preGainNode);

    graph = { context, source, preGainNode, bands, masterGain };
    const { gains, enabled, preGain: preGainDb } = useEqStore.getState();
    applyEqToGraph(graph, gains, enabled, preGainDb);
    syncMasterGain(graph);
    return true;
  } catch (err) {
    console.warn('[psysonic] radio Web Audio EQ attach failed:', err);
    audio.removeAttribute('crossorigin');
    graph = null;
    return false;
  }
}

export function applyRadioEqSettings(gains: number[], enabled: boolean, preGainDb: number): void {
  if (!graph) return;
  applyEqToGraph(graph, gains, enabled, preGainDb);
}

export function setRadioEqMasterVolume(volume: number): void {
  pendingMasterVolume = clampVolume(volume);
  if (graph) syncMasterGain(graph);
}

/** Route loudness through the graph when attached; otherwise native element volume. */
export function applyRadioOutputVolume(volume: number, graphActive: boolean): void {
  setRadioEqMasterVolume(volume);
  if (graphActive && graph) {
    return;
  }
}

export function shouldUseRadioEqGraph(): boolean {
  return useEqStore.getState().enabled;
}

/**
 * Live EQ store → Web Audio graph. Toggling EQ/presets/sliders updates filter
 * nodes instantly — no stream restart (issue #1276).
 */
export function bindRadioEqStore(): () => void {
  if (!eqStoreUnsub) {
    const push = (): void => {
      const { gains, enabled, preGain } = useEqStore.getState();
      applyRadioEqSettings(gains, enabled, preGain);
    };
    push();
    eqStoreUnsub = useEqStore.subscribe((state, prev) => {
      if (
        state.gains !== prev.gains
        || state.enabled !== prev.enabled
        || state.preGain !== prev.preGain
      ) {
        push();
      }
    });
  }
  return () => {
    eqStoreUnsub?.();
    eqStoreUnsub = null;
  };
}

export function _radioEqGraphForTest(): RadioEqGraph | null {
  return graph;
}

export function _resetRadioEqGraphForTest(): void {
  eqStoreUnsub?.();
  eqStoreUnsub = null;
  if (graph) {
    void graph.context.close();
    graph = null;
  }
  if (sharedContext) {
    void sharedContext.close();
    sharedContext = null;
  }
  pendingMasterVolume = 1;
}

export { clampBandGain, clampPreGainDb, dbToLinear };
