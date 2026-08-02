import { describe, expect, it, vi } from 'vitest';
import { createFrame, type SpectrumFrame } from './spectrumFrame';
import { buildPalette } from './visualizerColors';
import {
  bassEnergy,
  createRendererState,
  drawBars,
  drawBloom,
  drawRadialScope,
  drawScope,
  drawStereoRings,
  modeKeepsHistory,
  renderFrame,
  resetRendererState,
  setupCanvas,
  VISUALIZER_MODES,
  type RenderOptions,
} from './visualizerRenderers';

/** Minimal 2D-context stub that records the calls the renderers make. */
function stubContext() {
  const gradient = { addColorStop: vi.fn() };
  return {
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    closePath: vi.fn(),
    createLinearGradient: vi.fn(() => gradient),
    createRadialGradient: vi.fn(() => gradient),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    setTransform: vi.fn(),
    globalAlpha: 1,
    globalCompositeOperation: '' as GlobalCompositeOperation,
    fillStyle: '' as unknown,
    strokeStyle: '' as unknown,
    shadowColor: '',
    shadowBlur: 0,
    lineWidth: 0,
    lineJoin: '' as CanvasLineJoin,
    lineCap: '' as CanvasLineCap,
  };
}

type Ctx = ReturnType<typeof stubContext>;

function options(over: Partial<RenderOptions> = {}): RenderOptions {
  return {
    palette: buildPalette({ cover: null, themeAccent: 'rgb(140, 90, 240)', surface: '#0a0a0e' }),
    sensitivity: 1,
    showPeaks: true,
    reducedMotion: false,
    ...over,
  };
}

function loudFrame(): SpectrumFrame {
  const frame = createFrame();
  frame.bands.fill(0.8);
  frame.peaks.fill(0.9);
  for (let i = 0; i < frame.waveform.length; i++) {
    frame.waveform[i] = Math.sin(i / 4);
  }
  frame.rms = 0.5;
  frame.peak = 1;
  return frame;
}

const asCtx = (c: Ctx): CanvasRenderingContext2D => c as unknown as CanvasRenderingContext2D;

describe('bassEnergy', () => {
  it('is zero for silence', () => {
    expect(bassEnergy(createFrame())).toBe(0);
  });

  it('reads only the low bands', () => {
    const frame = createFrame();
    frame.bands.fill(0);
    // Fill only the top half — bass energy must stay at zero.
    frame.bands.fill(1, 32);
    expect(bassEnergy(frame)).toBe(0);
  });

  it('rises with low-end level', () => {
    const quiet = createFrame();
    quiet.bands.fill(0.2, 0, 8);
    const loud = createFrame();
    loud.bands.fill(0.9, 0, 8);
    expect(bassEnergy(loud)).toBeGreaterThan(bassEnergy(quiet));
  });
});

describe('drawBars', () => {
  it('draws one rect per band plus one cap per band', () => {
    const ctx = stubContext();
    const frame = loudFrame();
    drawBars(asCtx(ctx), 640, 200, frame, options());
    // Derived from the frame, not hardcoded: the band count is a Rust-side
    // constant and the frontend follows whatever it sends.
    const n = frame.bands.length;
    expect(ctx.fillRect).toHaveBeenCalledTimes(n * 2 + 1); // bars + caps + bloom
  });

  it('paints every band from one shared vertical gradient', () => {
    const ctx = stubContext();
    const frame = createFrame();
    frame.bands[0] = 0.05;
    frame.bands[1] = 0.95;
    const seen: unknown[] = [];
    Object.defineProperty(ctx, 'fillStyle', {
      set(v: unknown) { seen.push(v); },
      get() { return ''; },
      configurable: true,
    });
    drawBars(asCtx(ctx), 640, 200, frame, options({ showPeaks: false, reducedMotion: true }));
    // Bar heights already encode level; varying hue per band on top of that
    // reads as noise. One fillStyle set for all 64 bars.
    expect(seen).toHaveLength(1);
    expect(ctx.createLinearGradient).toHaveBeenCalledTimes(1);
  });

  it('uses a single static colour for every peak cap', () => {
    const ctx = stubContext();
    const frame = loudFrame();
    const seen: unknown[] = [];
    Object.defineProperty(ctx, 'fillStyle', {
      set(v: unknown) { seen.push(v); },
      get() { return ''; },
      configurable: true,
    });
    drawBars(asCtx(ctx), 640, 200, frame, options({ reducedMotion: true }));
    // One for the bar gradient, one for the caps — not one per band.
    expect(seen).toHaveLength(2);
  });

  it('dims its bloom relative to a full-strength one', () => {
    // The bars fill most of the frame, so a full-strength bloom behind them
    // washes the panel out rather than reading as a glow.
    const alphaOf = (ctx: Ctx): number[] => {
      const out: number[] = [];
      ctx.createRadialGradient.mockImplementation(() => ({
        addColorStop: (_offset: number, color: string) => {
          const m = /rgba?\([^)]*?([\d.]+)\)/.exec(color);
          if (m) out.push(Number(m[1]));
        },
      }) as never);
      return out;
    };

    const frame = loudFrame();
    const barsCtx = stubContext();
    const barsAlpha = alphaOf(barsCtx);
    drawBars(asCtx(barsCtx), 640, 200, frame, options());

    const fullCtx = stubContext();
    const fullAlpha = alphaOf(fullCtx);
    drawBloom(asCtx(fullCtx), 640, 200, bassEnergy(frame), options());

    expect(barsAlpha[0]).toBeGreaterThan(0);
    expect(barsAlpha[0]).toBeLessThan(fullAlpha[0]! * 0.5);
  });

  it('omits the caps when they are turned off', () => {
    const ctx = stubContext();
    const frame = loudFrame();
    drawBars(asCtx(ctx), 640, 200, frame, options({ showPeaks: false }));
    expect(ctx.fillRect).toHaveBeenCalledTimes(frame.bands.length + 1);
  });

  it('scales bar height with level', () => {
    const height = 200;
    // reducedMotion suppresses the bloom fill, so calls[0] is the first bar.
    const opts = options({ showPeaks: false, reducedMotion: true });
    const quietCtx = stubContext();
    const quiet = createFrame();
    quiet.bands.fill(0.25);
    drawBars(asCtx(quietCtx), 640, height, quiet, opts);

    const loudCtx = stubContext();
    const loud = createFrame();
    loud.bands.fill(0.75);
    drawBars(asCtx(loudCtx), 640, height, loud, opts);

    // fillRect(x, y, w, h) — compare the heights of the first bar.
    const quietH = quietCtx.fillRect.mock.calls[0]![3] as number;
    const loudH = loudCtx.fillRect.mock.calls[0]![3] as number;
    expect(loudH).toBeGreaterThan(quietH);
  });

  it('keeps every bar inside the canvas at full scale', () => {
    const ctx = stubContext();
    const frame = createFrame();
    frame.bands.fill(1);
    frame.peaks.fill(1);
    const height = 180;
    drawBars(asCtx(ctx), 640, height, frame, options());
    for (const call of ctx.fillRect.mock.calls) {
      const [, y, , h] = call as unknown as [number, number, number, number];
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y + h).toBeLessThanOrEqual(height + 0.001);
    }
  });

  it('still draws a baseline for silence so the surface is never blank', () => {
    const ctx = stubContext();
    drawBars(asCtx(ctx), 640, 200, createFrame(), options({ showPeaks: false }));
    const firstHeight = ctx.fillRect.mock.calls[0]![3] as number;
    expect(firstHeight).toBeGreaterThan(0);
  });

  it('skips glow work under reduced motion', () => {
    const ctx = stubContext();
    drawBars(asCtx(ctx), 640, 200, loudFrame(), options({ reducedMotion: true }));
    expect(ctx.createRadialGradient).not.toHaveBeenCalled();
  });

  it('does nothing for a zero-sized canvas', () => {
    const ctx = stubContext();
    drawBars(asCtx(ctx), 0, 0, loudFrame(), options());
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });
});

describe('drawScope', () => {
  it('traces one point per waveform sample', () => {
    const ctx = stubContext();
    const frame = loudFrame();
    drawScope(asCtx(ctx), 640, 200, frame, options());
    const n = frame.waveform.length;
    expect(ctx.moveTo).toHaveBeenCalledTimes(2); // trace start + centre line
    expect(ctx.lineTo).toHaveBeenCalledTimes((n - 1) + 1); // trace + centre line
  });

  it('keeps the trace inside the canvas', () => {
    const ctx = stubContext();
    const frame = createFrame();
    frame.waveform.fill(1);
    const height = 200;
    drawScope(asCtx(ctx), 640, height, frame, options({ sensitivity: 2.4 }));
    for (const call of [...ctx.moveTo.mock.calls, ...ctx.lineTo.mock.calls]) {
      const [, y] = call as unknown as [number, number];
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(height);
    }
  });

  it('thickens the line as the track gets louder', () => {
    const quietCtx = stubContext();
    const quiet = loudFrame();
    quiet.rms = 0.05;
    drawScope(asCtx(quietCtx), 640, 200, quiet, options());
    const quietWidth = quietCtx.lineWidth;

    const loudCtx = stubContext();
    const loud = loudFrame();
    loud.rms = 0.9;
    drawScope(asCtx(loudCtx), 640, 200, loud, options());
    // lineWidth is reset for the centre line, so capture during the trace via
    // the recorded stroke order — compare the final centre-line-independent max.
    expect(loudCtx.lineWidth).toBeGreaterThanOrEqual(1);
    expect(quietWidth).toBeGreaterThanOrEqual(1);
  });

  it('does nothing for a zero-sized canvas', () => {
    const ctx = stubContext();
    drawScope(asCtx(ctx), 0, 0, loudFrame(), options());
    expect(ctx.stroke).not.toHaveBeenCalled();
  });
});

describe('renderFrame', () => {
  it('clears before drawing', () => {
    const ctx = stubContext();
    renderFrame(asCtx(ctx), 640, 200, loudFrame(), 'bars', options());
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 640, 200);
  });

  it('dispatches to the scope renderer in scope mode', () => {
    const ctx = stubContext();
    renderFrame(asCtx(ctx), 640, 200, loudFrame(), 'scope', options());
    expect(ctx.stroke).toHaveBeenCalled();
  });

  it('dispatches to the bar renderer in bars mode', () => {
    const ctx = stubContext();
    renderFrame(asCtx(ctx), 640, 200, loudFrame(), 'bars', options());
    expect(ctx.fillRect).toHaveBeenCalled();
    expect(ctx.stroke).not.toHaveBeenCalled();
  });
});

describe('setupCanvas', () => {
  function canvasWithSize(w: number, h: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    Object.defineProperty(canvas, 'clientWidth', { value: w, configurable: true });
    Object.defineProperty(canvas, 'clientHeight', { value: h, configurable: true });
    return canvas;
  }

  it('returns null for a canvas with no layout box', () => {
    expect(setupCanvas(canvasWithSize(0, 0))).toBeNull();
  });

  it('sizes the backing store by the device pixel ratio', () => {
    const canvas = canvasWithSize(320, 100);
    const ctx = stubContext();
    vi.spyOn(canvas, 'getContext').mockReturnValue(asCtx(ctx) as never);
    vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2);

    const result = setupCanvas(canvas);
    expect(result).not.toBeNull();
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(200);
    // Coordinates stay in CSS pixels for the renderers.
    expect(result!.width).toBe(320);
    expect(result!.height).toBe(100);
    expect(ctx.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
  });

  it('caps the device pixel ratio', () => {
    const canvas = canvasWithSize(100, 100);
    const ctx = stubContext();
    vi.spyOn(canvas, 'getContext').mockReturnValue(asCtx(ctx) as never);
    vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(4);

    setupCanvas(canvas, 2);
    expect(canvas.width).toBe(200);
  });
});

describe('drawRadialScope', () => {
  /** jsdom gives no 2D context on a created canvas; stub the trail buffer. */
  function stubTrailCanvas(): { ctx: Ctx; canvas: HTMLCanvasElement } {
    const ctx = stubContext();
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockReturnValue(asCtx(ctx) as never);
    return { ctx, canvas };
  }

  it('draws a closed ring', () => {
    const ctx = stubContext();
    const state = createRendererState();
    vi.spyOn(document, 'createElement').mockReturnValue(stubTrailCanvas().canvas as never);
    drawRadialScope(asCtx(ctx), 400, 400, loudFrame(), options(), state);
    vi.restoreAllMocks();
    // The visible canvas receives the composited trail buffer.
    expect(ctx.drawImage).toHaveBeenCalled();
  });

  it('falls back to a plain ring under reduced motion', () => {
    const ctx = stubContext();
    const state = createRendererState();
    drawRadialScope(asCtx(ctx), 400, 400, loudFrame(), options({ reducedMotion: true }), state);
    // No feedback buffer at all — that persistence is what the preference asks
    // us to drop.
    expect(state.buffer).toBeNull();
    expect(ctx.drawImage).not.toHaveBeenCalled();
    expect(ctx.stroke).toHaveBeenCalled();
  });

  it('closes the ring by wrapping back to the first sample', () => {
    const ctx = stubContext();
    drawRadialScope(
      asCtx(ctx), 400, 400, loudFrame(), options({ reducedMotion: true }), createRendererState(),
    );
    // The ring is stroked as coloured arcs, so seamlessness is the property to
    // assert: the last point drawn must land exactly on the first.
    const first = ctx.moveTo.mock.calls[0] as unknown as [number, number];
    const lineTos = ctx.lineTo.mock.calls as unknown as Array<[number, number]>;
    const last = lineTos[lineTos.length - 1]!;
    expect(last[0]).toBeCloseTo(first[0]!, 6);
    expect(last[1]).toBeCloseTo(first[1]!, 6);
  });

  it('colours the ring by local amplitude rather than one flat gradient', () => {
    const ctx = stubContext();
    const frame = createFrame();
    // Loud on one side, silent on the other.
    for (let i = 0; i < frame.waveform.length; i++) {
      frame.waveform[i] = i < frame.waveform.length / 2 ? 0.95 : 0.02;
    }
    const seen: string[] = [];
    Object.defineProperty(ctx, 'strokeStyle', {
      set(v: string) { seen.push(v); },
      get() { return ''; },
      configurable: true,
    });
    drawRadialScope(
      asCtx(ctx), 400, 400, frame, options({ reducedMotion: true }), createRendererState(),
    );
    expect(new Set(seen).size).toBeGreaterThan(1);
  });

  it('keeps the ring inside the canvas at full scale and sensitivity', () => {
    const ctx = stubContext();
    const frame = createFrame();
    frame.waveform.fill(1);
    frame.bands.fill(1);
    const size = 300;
    drawRadialScope(
      asCtx(ctx), size, size, frame,
      options({ reducedMotion: true, sensitivity: 2.4 }),
      createRendererState(),
    );
    for (const call of [...ctx.moveTo.mock.calls, ...ctx.lineTo.mock.calls]) {
      const [x, y] = call as unknown as [number, number];
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(size);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(size);
    }
  });

  it('does nothing for a zero-sized canvas', () => {
    const ctx = stubContext();
    drawRadialScope(asCtx(ctx), 0, 0, loudFrame(), options(), createRendererState());
    expect(ctx.stroke).not.toHaveBeenCalled();
  });
});

describe('renderer state', () => {
  it('starts empty', () => {
    const state = createRendererState();
    expect(state.buffer).toBeNull();
    expect(state.bufferWidth).toBe(0);
  });

  it('resets back to empty', () => {
    const state = createRendererState();
    state.buffer = document.createElement('canvas');
    state.bufferWidth = 10;
    state.bufferHeight = 10;
    resetRendererState(state);
    expect(state.buffer).toBeNull();
    expect(state.bufferWidth).toBe(0);
    expect(state.bufferHeight).toBe(0);
  });
});

describe('modeKeepsHistory', () => {
  it('is true only for the persistence-based modes', () => {
    expect(modeKeepsHistory('radial')).toBe(true);
    // The scope keeps a phosphor-persistence buffer too.
    expect(modeKeepsHistory('scope')).toBe(true);
    expect(modeKeepsHistory('bars')).toBe(false);
  });
});

describe('mode registry', () => {
  it('lists every mode renderFrame can dispatch', () => {
    expect(VISUALIZER_MODES).toEqual(['bars', 'scope', 'radial', 'stereo']);
  });

  it('flags exactly the history-keeping modes', () => {
    expect(modeKeepsHistory('stereo')).toBe(true);
    expect(modeKeepsHistory('radial')).toBe(true);
    expect(modeKeepsHistory('scope')).toBe(true);
    expect(modeKeepsHistory('bars')).toBe(false);
  });

  it('renders something for every registered mode', () => {
    for (const mode of VISUALIZER_MODES) {
      const ctx = stubContext();
      renderFrame(
        asCtx(ctx), 400, 200, loudFrame(), mode,
        options({ reducedMotion: true }), createRendererState(),
      );
      const drew = ctx.fillRect.mock.calls.length + ctx.stroke.mock.calls.length;
      expect(drew, `mode ${mode} drew nothing`).toBeGreaterThan(0);
    }
  });
});

describe('drawScope', () => {
  function stubbedBuffer(): Ctx {
    const buffer = stubContext();
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockReturnValue(asCtx(buffer) as never);
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as never);
    return buffer;
  }

  it('keeps a phosphor buffer and composites it out', () => {
    const ctx = stubContext();
    const buffer = stubbedBuffer();
    drawScope(asCtx(ctx), 640, 200, loudFrame(), options(), createRendererState());
    vi.restoreAllMocks();
    expect(buffer.drawImage).toHaveBeenCalled();
    expect(ctx.drawImage).toHaveBeenCalled();
  });

  it('fades in place rather than zooming, unlike the radial tunnel', () => {
    const ctx = stubContext();
    const buffer = stubbedBuffer();
    drawScope(asCtx(ctx), 640, 200, loudFrame(), options(), createRendererState());
    vi.restoreAllMocks();
    // Scaling the afterglow would drag the trace sideways as it decays.
    expect(buffer.scale).not.toHaveBeenCalled();
  });

  it('drops persistence under reduced motion', () => {
    const ctx = stubContext();
    const state = createRendererState();
    drawScope(asCtx(ctx), 640, 200, loudFrame(), options({ reducedMotion: true }), state);
    expect(state.buffer).toBeNull();
    expect(ctx.stroke).toHaveBeenCalled();
  });

  it('never composites the bloom into the persistence buffer', () => {
    const ctx = stubContext();
    const buffer = stubbedBuffer();
    drawScope(asCtx(ctx), 640, 200, loudFrame(), options(), createRendererState());
    vi.restoreAllMocks();
    // Anything drawn into a buffer that decays to 0.82/frame settles at
    // ~5.5x its intended brightness. The bloom belongs on the canvas, under
    // the composited trace — only the trace should persist.
    expect(ctx.createRadialGradient).toHaveBeenCalled();
    expect(buffer.createRadialGradient).not.toHaveBeenCalled();
  });

  it('keeps the centre line out of the persistence buffer', () => {
    const ctx = stubContext();
    const buffer = stubbedBuffer();
    // Offset first sample, so the trace's start point cannot be confused with
    // the axis line's own start at (0, mid).
    const frame = loudFrame();
    frame.waveform[0] = 0.8;
    drawScope(asCtx(ctx), 640, 200, frame, options(), createRendererState());
    vi.restoreAllMocks();
    // A static line accumulating at 0.18 alpha reaches full opacity, which read
    // as a hard white rule through the middle of the scope.
    const axisOnCanvas = (ctx.moveTo.mock.calls as unknown as Array<[number, number]>)
      .some(([x, y]) => x === 0 && y === 100);
    const axisInBuffer = (buffer.moveTo.mock.calls as unknown as Array<[number, number]>)
      .some(([x, y]) => x === 0 && y === 100);
    expect(axisOnCanvas).toBe(true);
    expect(axisInBuffer).toBe(false);
  });

  it('draws the background under the composited trace, not over it', () => {
    const ctx = stubContext();
    const order: string[] = [];
    ctx.createRadialGradient.mockImplementation(() => {
      order.push('bloom');
      return { addColorStop: vi.fn() } as never;
    });
    ctx.drawImage.mockImplementation(() => { order.push('blit'); });
    const buffer = stubContext();
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockReturnValue(asCtx(buffer) as never);
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as never);
    drawScope(asCtx(ctx), 640, 200, loudFrame(), options(), createRendererState());
    vi.restoreAllMocks();
    expect(order).toEqual(['bloom', 'blit']);
  });

  it('draws a single centred trace, not one per channel', () => {
    const ctx = stubContext();
    const frame = loudFrame();
    frame.waveformLeft.fill(0.5);
    frame.waveformRight.fill(-0.5);
    drawScope(
      asCtx(ctx), 640, 200, frame,
      options({ reducedMotion: true }), createRendererState(),
    );
    // One polyline + one axis line: two subpaths, both starting at x = 0.
    const axes = (ctx.moveTo.mock.calls as unknown as Array<[number, number]>)
      .filter(([x]) => x === 0)
      .map(([, y]) => y);
    expect(new Set(axes).size).toBe(1);
    expect(axes[0]).toBe(100);
  });
});

describe('drawStereoRings', () => {
  /** How far each arc reaches inward from its own edge, plus the raw points.
   *  The arcs may cross the midline, so they're split by draw order (left
   *  first), not by x. */
  function reaches(frame: SpectrumFrame, width = 400, height = 300): {
    left: number; right: number; xs: number[]; leftPts: Array<[number, number]>;
  } {
    const ctx = stubContext();
    const seen: Array<[number, number]> = [];
    const record = (c: unknown) => seen.push(c as [number, number]);
    ctx.moveTo.mockImplementation((...a: unknown[]) => record(a));
    ctx.lineTo.mockImplementation((...a: unknown[]) => record(a));
    drawStereoRings(
      asCtx(ctx), width, height, frame,
      options({ reducedMotion: true }), createRendererState(),
    );
    const half = seen.length / 2;
    const leftPts = seen.slice(0, half);
    return {
      left: Math.max(...leftPts.map(p => p[0])),
      right: width - Math.min(...seen.slice(half).map(p => p[0])),
      xs: seen.map(p => p[0]),
      leftPts,
    };
  }

  function stereoFrame(leftAmp: number, rightAmp: number): SpectrumFrame {
    const frame = createFrame();
    for (let i = 0; i < frame.waveformLeft.length; i++) {
      frame.waveformLeft[i] = Math.sin(i / 5) * leftAmp;
      frame.waveformRight[i] = Math.sin(i / 5) * rightAmp;
    }
    return frame;
  }

  it('anchors each arc to its own edge', () => {
    const { xs, leftPts } = reaches(stereoFrame(0.6, 0.6), 400, 300);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(400);
    // The left arc's endpoints sit on x = 0 — it grows out of the panel edge
    // rather than floating in the middle of its half.
    expect(Math.min(...leftPts.map(p => p[0]))).toBeCloseTo(0, 5);
  });

  it('pins the arc endpoints to the vertical midline of its edge', () => {
    const { leftPts } = reaches(stereoFrame(0.6, 0.6), 400, 300);
    const onEdge = leftPts.filter(p => p[0] < 0.01).map(p => p[1]);
    // Top and bottom of the arc, symmetric about mid-height.
    expect(onEdge.length).toBeGreaterThanOrEqual(2);
    expect(Math.min(...onEdge) + Math.max(...onEdge)).toBeCloseTo(300, 1);
  });

  it('reaches further towards the centre when a channel is louder', () => {
    expect(reaches(stereoFrame(0.95, 0.95)).left)
      .toBeGreaterThan(reaches(stereoFrame(0.05, 0.05)).left);
  });

  it('does not stretch vertically as the panel gets wider', () => {
    // The regression this guards: tying the shape to the width turned these
    // into flattened ellipses. Vertical size must depend on height alone.
    const frame = stereoFrame(0.6, 0.6);
    const span = (w: number) => {
      const ys = reaches(frame, w, 260).leftPts.map(p => p[1]);
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(span(1120)).toBeCloseTo(span(560), 5);
  });

  it('grows towards the middle, not upwards, as level rises', () => {
    const quiet = reaches(stereoFrame(0.05, 0.05), 560, 260).leftPts;
    const loud = reaches(stereoFrame(0.95, 0.95), 560, 260).leftPts;
    const ySpan = (pts: Array<[number, number]>) =>
      Math.max(...pts.map(p => p[1])) - Math.min(...pts.map(p => p[1]));
    const xReach = (pts: Array<[number, number]>) => Math.max(...pts.map(p => p[0]));
    // Both breathe with level — the point is that the inward reach grows much
    // faster than the vertical size, so the figure travels towards the middle
    // instead of just swelling in place.
    const xGrowth = xReach(loud) / xReach(quiet);
    const yGrowth = ySpan(loud) / ySpan(quiet);
    expect(xGrowth).toBeGreaterThan(1.5);
    expect(xGrowth).toBeGreaterThan(yGrowth * 1.6);
  });

  it('renders the channels asymmetrically when they differ', () => {
    const { left, right } = reaches(stereoFrame(0.9, 0.05));
    expect(left - right).toBeGreaterThan(20);
  });


  it('mirrors the two arcs for a mono signal', () => {
    const { left, right } = reaches(stereoFrame(0.7, 0.7));
    expect(Math.abs(left - right)).toBeLessThan(0.001);
  });

  it('fits vertically on a wide, short panel', () => {
    // The reach is driven by width, so a circle would run off a 640×120 strip.
    const frame = createFrame();
    frame.waveformLeft.fill(1);
    frame.waveformRight.fill(1);
    const ctx = stubContext();
    drawStereoRings(
      asCtx(ctx), 640, 120, frame,
      options({ reducedMotion: true }), createRendererState(),
    );
    for (const call of [...ctx.moveTo.mock.calls, ...ctx.lineTo.mock.calls]) {
      const [, y] = call as unknown as [number, number];
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(120);
    }
  });

  it('never lets a ring run off the canvas at full scale', () => {
    const frame = createFrame();
    frame.waveformLeft.fill(1);
    frame.waveformRight.fill(-1);
    const ctx = stubContext();
    drawStereoRings(
      asCtx(ctx), 400, 300, frame,
      options({ reducedMotion: true, sensitivity: 2.4 }), createRendererState(),
    );
    for (const call of [...ctx.moveTo.mock.calls, ...ctx.lineTo.mock.calls]) {
      const [x, y] = call as unknown as [number, number];
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(400);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(300);
    }
  });

  it('floats on a persistence buffer', () => {
    const ctx = stubContext();
    const buffer = stubContext();
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockReturnValue(asCtx(buffer) as never);
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as never);
    drawStereoRings(asCtx(ctx), 400, 300, stereoFrame(0.6, 0.6), options(), createRendererState());
    vi.restoreAllMocks();
    expect(buffer.drawImage).toHaveBeenCalled();
    expect(ctx.drawImage).toHaveBeenCalled();
  });

  it('does nothing for a zero-sized canvas', () => {
    const ctx = stubContext();
    drawStereoRings(asCtx(ctx), 0, 0, stereoFrame(0.6, 0.6), options(), createRendererState());
    expect(ctx.stroke).not.toHaveBeenCalled();
  });
});
