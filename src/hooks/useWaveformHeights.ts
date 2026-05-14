import React, { useEffect } from 'react';
import type { SeekbarStyle } from '../store/authStoreTypes';
import type { AnimState } from '../utils/waveform/waveformSeekHelpers';
import {
  ANIMATED_STYLES, BAR_COUNT, FLAT_WAVE_NORM, WAVE_MORPH_MS,
  binsToHeights, easeOutCubic, heightsNearlyEqual,
  makeFlatWaveHeights, makeHeights,
} from '../utils/waveform/waveformSeekHelpers';
import { drawSeekbar } from '../utils/waveform/waveformSeekRenderers';

interface Args {
  trackId: string | undefined;
  waveformBins: number[] | null | undefined;
  seekbarStyle: SeekbarStyle;
  heightsRef: React.MutableRefObject<Float32Array | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  styleRef: React.MutableRefObject<SeekbarStyle>;
  progressRef: React.MutableRefObject<number>;
  bufferedRef: React.MutableRefObject<number>;
  animStateRef: React.MutableRefObject<AnimState>;
}

/** Manages `heightsRef` for the seekbar: bootstraps deterministic bars for
 *  pseudowave, animates a morph between waveform analysis updates, and falls
 *  back to a flat wave when no bins exist yet. */
export function useWaveformHeights({
  trackId, waveformBins, seekbarStyle,
  heightsRef, canvasRef, styleRef, progressRef, bufferedRef, animStateRef,
}: Args) {
  useEffect(() => {
    if (!trackId) {
      heightsRef.current = null;
      return;
    }
    // Pseudowave is the deterministic per-track-ID variant — no analysis needed,
    // no morph animation, no flat-fallback. It just sits there looking like a
    // waveform.
    if (seekbarStyle === 'pseudowave') {
      heightsRef.current = makeHeights(trackId);
      const canvas = canvasRef.current;
      if (canvas && !ANIMATED_STYLES.has(seekbarStyle)) {
        drawSeekbar(canvas, seekbarStyle, heightsRef.current, progressRef.current, bufferedRef.current, animStateRef.current);
      }
      return;
    }
    if (waveformBins && waveformBins.length > 0) {
      const h = binsToHeights(waveformBins);
      const prev = heightsRef.current;
      if (!prev || prev.length !== BAR_COUNT) {
        heightsRef.current = h;
        return;
      }
      if (heightsNearlyEqual(prev, h, 0.02)) {
        heightsRef.current = h;
        return;
      }
      const from = new Float32Array(prev);
      const to = h;
      const startedAt = performance.now();
      let raf = 0;
      const step = (now: number) => {
        const p = easeOutCubic((now - startedAt) / WAVE_MORPH_MS);
        const next = new Float32Array(BAR_COUNT);
        for (let i = 0; i < BAR_COUNT; i++) {
          next[i] = from[i] + (to[i] - from[i]) * p;
        }
        heightsRef.current = next;
        if (!ANIMATED_STYLES.has(styleRef.current)) {
          const canvas = canvasRef.current;
          if (canvas) drawSeekbar(canvas, styleRef.current, next, progressRef.current, bufferedRef.current, animStateRef.current);
        }
        if (p < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
      return () => cancelAnimationFrame(raf);
    }
    if (heightsRef.current?.length === BAR_COUNT) {
      const current = heightsRef.current;
      let isAlreadyFlat = true;
      for (let i = 0; i < BAR_COUNT; i++) {
        if (Math.abs(current[i] - FLAT_WAVE_NORM) > 0.0001) {
          isAlreadyFlat = false;
          break;
        }
      }
      if (isAlreadyFlat) return;
      const from = new Float32Array(current);
      const to = makeFlatWaveHeights();
      const startedAt = performance.now();
      let raf = 0;
      const step = (now: number) => {
        const p = easeOutCubic((now - startedAt) / WAVE_MORPH_MS);
        const next = new Float32Array(BAR_COUNT);
        for (let i = 0; i < BAR_COUNT; i++) {
          next[i] = from[i] + (to[i] - from[i]) * p;
        }
        heightsRef.current = next;
        if (!ANIMATED_STYLES.has(styleRef.current)) {
          const canvas = canvasRef.current;
          if (canvas) drawSeekbar(canvas, styleRef.current, next, progressRef.current, bufferedRef.current, animStateRef.current);
        }
        if (p < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
      return () => cancelAnimationFrame(raf);
    }
    // No analysis bins yet: render 500 flat bars immediately.
    heightsRef.current = makeFlatWaveHeights();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId, waveformBins, seekbarStyle]);
}
