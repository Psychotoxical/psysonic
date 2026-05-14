import type { SeekbarStyle } from '../../store/authStoreTypes';
import { bumpPerfCounter } from '../perf/perfTelemetry';
import { AnimState, makeAnimState } from './waveformSeekHelpers';
import {
  drawBar, drawLineDot, drawNeon, drawSegmented, drawThick, drawWaveform,
} from './waveformSeekRenderersStatic';
import {
  drawLiquidFill, drawParticleTrail, drawPulseWave, drawRetroTape,
} from './waveformSeekRenderersAnimated';

export function drawSeekbar(
  canvas: HTMLCanvasElement,
  style: SeekbarStyle,
  heights: Float32Array | null,
  progress: number,
  buffered: number,
  animState?: AnimState,
) {
  bumpPerfCounter('waveformDraws');
  const anim = animState ?? makeAnimState();
  switch (style) {
    case 'truewave':      drawWaveform(canvas, heights, progress, buffered); break;
    case 'pseudowave':    drawWaveform(canvas, heights, progress, buffered); break;
    case 'linedot':       drawLineDot(canvas, progress, buffered); break;
    case 'bar':           drawBar(canvas, progress, buffered); break;
    case 'thick':         drawThick(canvas, progress, buffered); break;
    case 'segmented':     drawSegmented(canvas, progress, buffered); break;
    case 'neon':          drawNeon(canvas, progress, buffered); break;
    case 'pulsewave':     drawPulseWave(canvas, progress, buffered, anim); break;
    case 'particletrail': drawParticleTrail(canvas, progress, buffered, anim); break;
    case 'liquidfill':    drawLiquidFill(canvas, progress, buffered, anim); break;
    case 'retrotape':     drawRetroTape(canvas, progress, buffered, anim); break;
    // Safety net: if a legacy or tampered persisted style sneaks past the
    // authStore migration, fall back to the truewave renderer instead of
    // leaving a blank canvas.
    default:              drawWaveform(canvas, heights, progress, buffered); break;
  }
}
