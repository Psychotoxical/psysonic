import { useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  getRadioSpectrumAnalyser,
  subscribeRadioSpectrumAvailability,
  usePlayerStore,
} from '@/features/playback';
import {
  applyAnalyserData,
  applyPayload,
  clearFrame,
  copyFrame,
  createFrame,
  createSpectrumEnvelopeState,
  decayFrameToSilence,
  interpolateFrames,
  resizeFrame,
  type SpectrumEnvelopeState,
  type SpectrumFrame,
  type SpectrumPayload,
} from '@/features/visualizer/utils/spectrumFrame';
import {
  acquireSpectrumFeed,
  setSpectrumFeedParams,
  type SpectrumFeedParams,
} from '@/features/visualizer/utils/spectrumSubscription';

/**
 * Live spectrum data for one visualizer surface.
 *
 * Two feeds, one shape:
 *  - Engine: local/Subsonic playback emits `audio:spectrum` from Rust.
 *  - Radio: the active HTMLAudioElement is sampled through Web Audio.
 *
 * The hook exposes a ref, never state. The render loop reads and mutates it
 * directly, while low-rate source changes only wake that loop imperatively.
 */
export interface SpectrumFeed {
  /** Interpolated frame to draw. Mutated in place - never store a reference. */
  frame: SpectrumFrame;
  /** True while the selected source is producing current analysis data. */
  hasSignal: boolean;
  /** True while another animation frame can change the visible result. */
  shouldAnimate: boolean;
  /** Advance the selected feed to `now` (ms). */
  sample: (now: number) => void;
  /** Wake a quiescent renderer when a fresh frame/source becomes available. */
  subscribe: (listener: () => void) => () => void;
}

/** Frames older than this are stale - playback stopped or the feed died. */
const SIGNAL_TIMEOUT_MS = 700;
/** Emit gaps at or under this (about 50 fps and up) render without interpolation. */
const INTERPOLATE_ABOVE_GAP_MS = 20;

interface FeedInternals {
  /** Native interpolation endpoints remain separate from the radio buffer. */
  nativePrev: SpectrumFrame;
  nativeNext: SpectrumFrame;
  radio: SpectrumFrame;
  radioEnvelope: SpectrumEnvelopeState;
  nativeLastArrival: number;
  nativePrevArrival: number;
  lastSample: number;
  lastRadioPull: number;
  params: SpectrumFeedParams;
  nativeLeaseActive: boolean;
  radioSelected: boolean;
  radioPlaying: boolean;
}

function matchFrameShape(target: SpectrumFrame, source: SpectrumFrame): void {
  if (
    target.bands.length !== source.bands.length
    || target.waveform.length !== source.waveform.length
  ) {
    resizeFrame(target, source.bands.length, source.waveform.length);
  }
}

function radioPlaybackState(): { selected: boolean; playing: boolean } {
  const { currentRadio, isPlaying } = usePlayerStore.getState();
  const selected = currentRadio != null;
  return { selected, playing: selected && isPlaying };
}

/**
 * Returns a ref because every frame is mutated outside React. Read `.current`
 * from an animation callback, not during render.
 */
export function useSpectrumFeed(
  active: boolean,
  params: SpectrumFeedParams,
): React.RefObject<SpectrumFeed> {
  const listenersRef = useRef(new Set<() => void>());
  const feedRef = useRef<SpectrumFeed>({
    frame: createFrame(),
    hasSignal: false,
    shouldAnimate: false,
    sample: () => {},
    subscribe: (listener) => {
      listenersRef.current.add(listener);
      return () => listenersRef.current.delete(listener);
    },
  });
  const ioRef = useRef<FeedInternals>({
    nativePrev: createFrame(),
    nativeNext: createFrame(),
    radio: createFrame(),
    radioEnvelope: createSpectrumEnvelopeState(),
    nativeLastArrival: 0,
    nativePrevArrival: 0,
    lastSample: 0,
    lastRadioPull: 0,
    params,
    nativeLeaseActive: false,
    radioSelected: false,
    radioPlaying: false,
  });

  // Parameter changes update the active task in place; they never re-listen or
  // release/reacquire this surface's feed lease.
  useEffect(() => {
    const io = ioRef.current;
    io.params = params;
    if (active && io.nativeLeaseActive) setSpectrumFeedParams(params);
  }, [active, params]);

  useEffect(() => {
    const feed = feedRef.current;
    const io = ioRef.current;
    const listeners = listenersRef.current;
    const notify = (): void => {
      for (const listener of listeners) listener();
    };

    if (!active) {
      clearFrame(feed.frame);
      clearFrame(io.nativePrev);
      clearFrame(io.nativeNext);
      clearFrame(io.radio);
      io.radioEnvelope = createSpectrumEnvelopeState(io.radio.bands.length);
      io.nativeLastArrival = 0;
      io.nativePrevArrival = 0;
      io.lastSample = 0;
      io.lastRadioPull = 0;
      io.nativeLeaseActive = false;
      io.radioSelected = false;
      io.radioPlaying = false;
      feed.hasSignal = false;
      feed.shouldAnimate = false;
      feed.sample = () => {};
      return;
    }

    let releaseNative: (() => void) | null = null;
    const setNativeLease = (needed: boolean): void => {
      if (needed) {
        if (releaseNative) return;
        releaseNative = acquireSpectrumFeed(io.params);
        io.nativeLeaseActive = true;
        return;
      }
      const release = releaseNative;
      releaseNative = null;
      io.nativeLeaseActive = false;
      release?.();
    };
    let unlisten: UnlistenFn | null = null;
    let disposed = false;

    const initialRadio = radioPlaybackState();
    io.radioSelected = initialRadio.selected;
    io.radioPlaying = initialRadio.playing;
    setNativeLease(!initialRadio.selected);
    const unsubscribePlayer = usePlayerStore.subscribe((state, previous) => {
      const nextSelected = state.currentRadio != null;
      const nextPlaying = nextSelected && state.isPlaying;
      const previousSelected = previous.currentRadio != null;
      const previousPlaying = previousSelected && previous.isPlaying;
      if (nextSelected === previousSelected && nextPlaying === previousPlaying) return;
      if (nextSelected !== previousSelected) {
        setNativeLease(!nextSelected);
        io.nativeLastArrival = 0;
        io.nativePrevArrival = 0;
      }
      io.radioSelected = nextSelected;
      io.radioPlaying = nextPlaying;
      io.lastSample = 0;
      io.lastRadioPull = 0;
      feed.hasSignal = false;
      feed.shouldAnimate = true;
      notify();
    });
    const unsubscribeRadioSpectrum = subscribeRadioSpectrumAvailability(() => {
      if (!io.radioSelected) return;
      io.lastRadioPull = 0;
      feed.shouldAnimate = true;
      notify();
    });

    void listen<SpectrumPayload>('audio:spectrum', (event) => {
      if (disposed) return;
      if (
        event.payload.bandCount !== io.nativeNext.bands.length
        || event.payload.waveCount !== io.nativeNext.waveformLeft.length
      ) {
        resizeFrame(io.nativePrev, event.payload.bandCount, event.payload.waveCount);
        resizeFrame(io.nativeNext, event.payload.bandCount, event.payload.waveCount);
      }

      copyFrame(io.nativePrev, io.nativeNext);
      if (!applyPayload(io.nativeNext, event.payload)) return;
      io.nativePrevArrival = io.nativeLastArrival;
      io.nativeLastArrival = performance.now();

      // Preserve native data even during radio playback, but only wake/render it
      // when the player store says the native engine owns the audible source.
      if (!io.radioSelected) {
        feed.hasSignal = true;
        feed.shouldAnimate = true;
        notify();
      }
    }).then((fn) => {
      if (disposed) void fn();
      else unlisten = fn;
    }).catch(() => { /* no Tauri host (tests, browser preview) */ });

    // Explicit ArrayBuffer backing: AnalyserNode's getByte* methods reject a
    // possibly-shared buffer.
    let freqBytes: Uint8Array<ArrayBuffer> | null = null;
    let timeBytes: Uint8Array<ArrayBuffer> | null = null;

    const pullRadio = (now: number): boolean => {
      const fps = Math.max(1, io.params.fps);
      const periodMs = 1_000 / fps;
      if (io.lastRadioPull > 0 && now - io.lastRadioPull < periodMs) return true;

      const analyser = getRadioSpectrumAnalyser();
      if (!analyser) return false;
      if (!freqBytes || freqBytes.length !== analyser.frequencyBinCount) {
        freqBytes = new Uint8Array(analyser.frequencyBinCount);
      }
      if (!timeBytes || timeBytes.length !== analyser.fftSize) {
        timeBytes = new Uint8Array(analyser.fftSize);
      }

      analyser.getByteFrequencyData(freqBytes);
      analyser.getByteTimeDomainData(timeBytes);
      const dt = io.lastRadioPull > 0 ? (now - io.lastRadioPull) / 1_000 : 1 / fps;
      applyAnalyserData(
        io.radio,
        freqBytes,
        timeBytes,
        analyser.context.sampleRate,
        dt,
        io.params.responsiveness,
        io.radioEnvelope,
      );
      io.lastRadioPull = now;
      return true;
    };

    feed.sample = (now: number) => {
      const defaultDt = 1 / Math.max(1, io.params.fps);
      const dt = io.lastSample > 0 ? Math.max(0, (now - io.lastSample) / 1_000) : defaultDt;
      io.lastSample = now;

      if (io.radioSelected) {
        if (io.radioPlaying && pullRadio(now)) {
          matchFrameShape(feed.frame, io.radio);
          copyFrame(feed.frame, io.radio);
          feed.hasSignal = true;
          feed.shouldAnimate = true;
        } else {
          feed.hasSignal = false;
          feed.shouldAnimate = decayFrameToSilence(feed.frame, dt);
        }
        return;
      }

      const last = io.nativeLastArrival;
      if (last === 0 || now - last > SIGNAL_TIMEOUT_MS) {
        feed.hasSignal = false;
        feed.shouldAnimate = decayFrameToSilence(feed.frame, dt);
        return;
      }

      feed.hasSignal = true;
      feed.shouldAnimate = true;
      matchFrameShape(feed.frame, io.nativeNext);

      // Holding interpolation one whole emit period behind is worthwhile only
      // when native frames are sparser than the display refresh.
      const gap = Math.max(1, last - io.nativePrevArrival);
      if (gap <= INTERPOLATE_ABOVE_GAP_MS) {
        copyFrame(feed.frame, io.nativeNext);
        return;
      }

      const t = Math.min(1, (now - last) / gap);
      interpolateFrames(feed.frame, io.nativePrev, io.nativeNext, t);
    };

    return () => {
      disposed = true;
      feed.sample = () => {};
      feed.hasSignal = false;
      feed.shouldAnimate = false;
      unsubscribePlayer();
      unsubscribeRadioSpectrum();
      if (unlisten) void unlisten();
      listeners.clear();
      setNativeLease(false);
    };
  }, [active]);

  return feedRef;
}
