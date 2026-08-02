import { useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getRadioSpectrumAnalyser } from '@/features/playback';
import {
  applyAnalyserData,
  applyPayload,
  clearFrame,
  copyFrame,
  createFrame,
  interpolateFrames,
  resizeFrame,
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
 *  • **Engine** — local/Subsonic playback decodes in Rust, so frames arrive as
 *    `audio:spectrum` events from the audio-thread tap.
 *  • **Radio** — internet streams play through an `HTMLAudioElement`, so frames
 *    are pulled from a Web Audio `AnalyserNode` (only available while the EQ
 *    graph is attached — see `getRadioSpectrumAnalyser`).
 *
 * The hook exposes a *ref*, never state: at 60 frames a second a `setState`
 * would re-render the tree sixty times a second and drop frames on the way.
 * The render loop reads `current.frame` directly on each `requestAnimationFrame`.
 */
export interface SpectrumFeed {
  /** Interpolated frame to draw. Mutated in place — never store a reference. */
  frame: SpectrumFrame;
  /** True once any audio has been seen; false while idle/stopped. */
  hasSignal: boolean;
  /** Advance the interpolation to `now` (ms). Called once per animation frame. */
  sample: (now: number) => void;
}

/** Frames older than this are stale — playback stopped or the feed died. */
const SIGNAL_TIMEOUT_MS = 700;
/** Emit gaps at or under this (≈50 fps and up) render without interpolation. */
const INTERPOLATE_ABOVE_GAP_MS = 20;

/** Mutable state the render loop and the listener share, outside React. */
interface FeedInternals {
  /** Interpolation endpoints. */
  prev: SpectrumFrame;
  next: SpectrumFrame;
  /** Arrival timestamps of the last two frames, for the interpolation clock. */
  lastArrival: number;
  prevArrival: number;
  /** Feed shape to request at acquisition; changes are pushed without re-listening. */
  params: SpectrumFeedParams;
}

/**
 * Returns a *ref* to the feed rather than the feed itself: the object is
 * mutated sixty times a second, and every alternative (state, a mutated
 * `useState` container) is either a re-render per frame or a lint violation.
 * Read `.current` from inside the animation loop, never during render.
 */
export function useSpectrumFeed(
  active: boolean,
  params: SpectrumFeedParams,
): React.RefObject<SpectrumFeed> {
  const feedRef = useRef<SpectrumFeed>({
    frame: createFrame(),
    hasSignal: false,
    sample: () => {},
  });
  const ioRef = useRef<FeedInternals>({
    prev: createFrame(),
    next: createFrame(),
    lastArrival: 0,
    prevArrival: 0,
    params,
  });

  // Declared before the subscribe effect so the first acquisition already sees
  // the requested rate (effects run in declaration order).
  useEffect(() => {
    ioRef.current.params = params;
    if (active) setSpectrumFeedParams(params);
  }, [active, params]);

  useEffect(() => {
    const feed = feedRef.current;
    const io = ioRef.current;

    if (!active) {
      clearFrame(feed.frame);
      clearFrame(io.prev);
      clearFrame(io.next);
      feed.hasSignal = false;
      feed.sample = () => {};
      return;
    }

    const { prev, next } = io;

    // ── Engine feed ──────────────────────────────────────────────────────────
    const release = acquireSpectrumFeed(io.params);
    let unlisten: UnlistenFn | null = null;
    let disposed = false;

    void listen<SpectrumPayload>('audio:spectrum', (event) => {
      // Follow the engine's band/wave counts. All three frames resize together:
      // the copies below use `Float32Array.set`, which throws if the source is
      // longer than the target.
      if (
        event.payload.bandCount !== next.bands.length
        || event.payload.waveCount !== next.waveformLeft.length
      ) {
        for (const f of [feed.frame, prev, next]) {
          resizeFrame(f, event.payload.bandCount, event.payload.waveCount);
        }
      }

      // Hand the current "next" to "prev" so the renderer interpolates from
      // where it actually is rather than snapping.
      prev.bands.set(next.bands);
      prev.peaks.set(next.peaks);
      prev.waveform.set(next.waveform);
      prev.rms = next.rms;
      prev.peak = next.peak;

      if (!applyPayload(next, event.payload)) return;
      io.prevArrival = io.lastArrival;
      io.lastArrival = performance.now();
    }).then((fn) => {
      if (disposed) void fn();
      else unlisten = fn;
    }).catch(() => { /* no Tauri host (tests, browser preview) */ });

    // ── Radio feed ───────────────────────────────────────────────────────────
    // Pulled rather than pushed, so it is read inside `sample` below.
    // Explicit ArrayBuffer backing: the analyser's getByte* methods reject a
    // possibly-shared buffer.
    let freqBytes: Uint8Array<ArrayBuffer> | null = null;
    let timeBytes: Uint8Array<ArrayBuffer> | null = null;

    const pullRadio = (now: number): boolean => {
      const analyser = getRadioSpectrumAnalyser();
      if (!analyser) return false;
      if (!freqBytes || freqBytes.length !== analyser.frequencyBinCount) {
        freqBytes = new Uint8Array(analyser.frequencyBinCount);
        timeBytes = new Uint8Array(analyser.fftSize);
      }
      analyser.getByteFrequencyData(freqBytes);
      analyser.getByteTimeDomainData(timeBytes!);
      applyAnalyserData(next, freqBytes, timeBytes!);
      // The analyser is already current, so there is nothing to interpolate
      // towards — collapse both endpoints onto it.
      prev.bands.set(next.bands);
      prev.peaks.set(next.peaks);
      io.prevArrival = now;
      io.lastArrival = now;
      return true;
    };

    feed.sample = (now: number) => {
      const fromRadio = pullRadio(now);
      const last = io.lastArrival;

      if (last === 0 || now - last > SIGNAL_TIMEOUT_MS) {
        // Nothing arriving: Rust stops emitting once its envelopes settle, so
        // fade what's on screen out rather than leaving bars frozen mid-air.
        feed.hasSignal = false;
        for (let i = 0; i < feed.frame.bands.length; i++) {
          feed.frame.bands[i] = (feed.frame.bands[i] ?? 0) * 0.86;
          feed.frame.peaks[i] = (feed.frame.peaks[i] ?? 0) * 0.86;
        }
        for (let i = 0; i < feed.frame.waveform.length; i++) {
          feed.frame.waveform[i] = (feed.frame.waveform[i] ?? 0) * 0.86;
        }
        feed.frame.rms *= 0.86;
        feed.frame.peak *= 0.86;
        return;
      }

      feed.hasSignal = true;
      if (fromRadio) {
        copyFrame(feed.frame, next);
        return;
      }

      // Interpolating between two arrivals structurally holds the display one
      // whole emit period behind the data: at t=0 (the instant a frame lands)
      // it draws the *previous* frame. That is a fair trade only when frames
      // are sparser than the display refresh — otherwise it is pure latency for
      // smoothing nobody can see. Above ~50 Hz, draw the newest frame outright.
      const gap = Math.max(1, last - io.prevArrival);
      if (gap <= INTERPOLATE_ABOVE_GAP_MS) {
        copyFrame(feed.frame, next);
        return;
      }

      // Using the measured gap rather than the nominal fps keeps the motion
      // smooth when the emit rate drifts (a busy main thread, a throttled
      // background window).
      const t = Math.min(1, (now - last) / gap);
      interpolateFrames(feed.frame, prev, next, t);
    };

    return () => {
      disposed = true;
      feed.sample = () => {};
      if (unlisten) void unlisten();
      release();
    };
  }, [active]);

  return feedRef;
}
