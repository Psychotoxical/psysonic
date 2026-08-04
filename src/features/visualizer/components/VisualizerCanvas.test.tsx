import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { latestIntersectionObserver, latestResizeObserver } from '@/test/mocks/browser';

const hoisted = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const feed = {
    frame: {
      bands: new Float32Array(128),
      peaks: new Float32Array(128),
      waveform: new Float32Array(256),
      waveformLeft: new Float32Array(256),
      waveformRight: new Float32Array(256),
      rms: 0,
      peak: 0,
      sampleRate: 48_000,
    },
    hasSignal: false,
    shouldAnimate: false,
    sample: vi.fn(),
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  const feedRef = { current: feed };
  const visualizerState = {
    mode: 'bars',
    sensitivity: 1,
    showPeaks: true,
    colorSource: 'album',
    fps: 60,
    responsiveness: 0.65,
  };

  return {
    listeners,
    feed,
    feedRef,
    visualizerState,
    palette: { current: { background: '#000', bars: ['#fff'] } },
    useSpectrumFeedMock: vi.fn(() => feedRef),
    renderFrameMock: vi.fn(),
    resetRendererStateMock: vi.fn(),
    setupCanvasMock: vi.fn(),
  };
});

vi.mock('@/features/visualizer/hooks/useSpectrumFeed', () => ({
  useSpectrumFeed: hoisted.useSpectrumFeedMock,
}));
vi.mock('@/features/visualizer/hooks/useVisualizerPalette', () => ({
  useVisualizerPalette: () => hoisted.palette.current,
}));
vi.mock('@/features/visualizer/store/visualizerStore', () => ({
  useVisualizerStore: (selector: (state: typeof hoisted.visualizerState) => unknown) =>
    selector(hoisted.visualizerState),
}));
vi.mock('@/features/visualizer/utils/visualizerRenderers', () => ({
  createRendererState: () => ({}),
  renderFrame: hoisted.renderFrameMock,
  resetRendererState: hoisted.resetRendererStateMock,
  setupCanvas: hoisted.setupCanvasMock,
}));

import VisualizerCanvas from './VisualizerCanvas';

function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    value: hidden,
  });
}

describe('VisualizerCanvas lifecycle', () => {
  const context = { clearRect: vi.fn() };
  let callbacks: Map<number, FrameRequestCallback>;
  let nextFrameId: number;

  const flushFrame = (now = 1_000): void => {
    const entry = callbacks.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (!entry) throw new Error('No animation frame is pending');
    callbacks.delete(entry[0]);
    act(() => entry[1](now));
  };

  beforeEach(() => {
    callbacks = new Map();
    nextFrameId = 0;
    setDocumentHidden(false);
    hoisted.listeners.clear();
    hoisted.feed.hasSignal = false;
    hoisted.feed.shouldAnimate = false;
    hoisted.palette.current = { background: '#000', bars: ['#fff'] };
    hoisted.visualizerState.mode = 'bars';
    hoisted.visualizerState.sensitivity = 1;
    hoisted.visualizerState.showPeaks = true;
    hoisted.feed.sample.mockReset();
    hoisted.feed.subscribe.mockClear();
    hoisted.useSpectrumFeedMock.mockClear();
    hoisted.renderFrameMock.mockClear();
    hoisted.resetRendererStateMock.mockClear();
    hoisted.setupCanvasMock.mockReset();
    hoisted.setupCanvasMock.mockReturnValue({
      ctx: context,
      width: 320,
      height: 180,
    });
    context.clearRect.mockClear();

    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      const id = ++nextFrameId;
      callbacks.set(id, callback);
      return id;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => {
      callbacks.delete(id);
    }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(context as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    cleanup();
    setDocumentHidden(false);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('quiesces when idle and wakes promptly for a fresh spectrum frame', () => {
    render(<VisualizerCanvas artUrl="" artKey="" />);
    expect(callbacks.size).toBe(1);

    flushFrame();
    expect(hoisted.renderFrameMock).toHaveBeenCalledTimes(1);
    expect(callbacks.size).toBe(0);

    hoisted.feed.sample.mockImplementationOnce(() => {
      hoisted.feed.hasSignal = true;
      hoisted.feed.shouldAnimate = false;
    });
    act(() => {
      for (const listener of hoisted.listeners) listener();
    });
    expect(callbacks.size).toBe(1);

    flushFrame(1_016);
    expect(hoisted.renderFrameMock).toHaveBeenCalledTimes(2);
    expect(callbacks.size).toBe(0);
  });

  it('stops and releases the feed while offscreen or document-hidden', () => {
    render(<VisualizerCanvas artUrl="" artKey="" />);
    const observer = latestIntersectionObserver();
    expect(observer).toBeDefined();
    expect(hoisted.useSpectrumFeedMock).toHaveBeenLastCalledWith(true, {
      fps: 60,
      responsiveness: 0.65,
    });

    act(() => observer?.emit(false));
    expect(hoisted.useSpectrumFeedMock).toHaveBeenLastCalledWith(false, {
      fps: 60,
      responsiveness: 0.65,
    });
    expect(callbacks.size).toBe(0);

    act(() => observer?.emit(true));
    expect(hoisted.useSpectrumFeedMock).toHaveBeenLastCalledWith(true, {
      fps: 60,
      responsiveness: 0.65,
    });
    expect(callbacks.size).toBe(1);

    setDocumentHidden(true);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(hoisted.useSpectrumFeedMock).toHaveBeenLastCalledWith(false, {
      fps: 60,
      responsiveness: 0.65,
    });
    expect(callbacks.size).toBe(0);

    setDocumentHidden(false);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(hoisted.useSpectrumFeedMock).toHaveBeenLastCalledWith(true, {
      fps: 60,
      responsiveness: 0.65,
    });
    expect(callbacks.size).toBe(1);
  });

  it('does not acquire or animate while explicitly paused', () => {
    const { rerender } = render(<VisualizerCanvas artUrl="" artKey="" paused />);
    expect(hoisted.useSpectrumFeedMock).toHaveBeenLastCalledWith(false, {
      fps: 60,
      responsiveness: 0.65,
    });
    expect(callbacks.size).toBe(0);

    rerender(<VisualizerCanvas artUrl="" artKey="" paused={false} />);
    expect(hoisted.useSpectrumFeedMock).toHaveBeenLastCalledWith(true, {
      fps: 60,
      responsiveness: 0.65,
    });
    expect(callbacks.size).toBe(1);
  });

  it('repaints once when mode, palette, or render settings change while idle', () => {
    const { rerender } = render(<VisualizerCanvas artUrl="" artKey="" />);
    flushFrame();
    expect(callbacks.size).toBe(0);

    hoisted.palette.current = { background: '#123', bars: ['#abc'] };
    hoisted.visualizerState.sensitivity = 1.5;
    hoisted.visualizerState.showPeaks = false;
    rerender(<VisualizerCanvas artUrl="" artKey="" mode="scope" />);

    expect(callbacks.size).toBe(1);
    flushFrame(1_016);
    expect(hoisted.renderFrameMock).toHaveBeenCalledTimes(2);
    expect(hoisted.renderFrameMock).toHaveBeenLastCalledWith(
      context,
      320,
      180,
      hoisted.feed.frame,
      'scope',
      expect.objectContaining({
        palette: hoisted.palette.current,
        sensitivity: 1.5,
        showPeaks: false,
      }),
      expect.anything(),
    );
    expect(callbacks.size).toBe(0);
  });

  it('repaints once when reduced-motion preference changes while idle', () => {
    let matches = false;
    let motionListener: EventListenerOrEventListenerObject | null = null;
    const motionQuery = {
      get matches() { return matches; },
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
        motionListener = listener;
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    } as unknown as MediaQueryList;
    vi.spyOn(window, 'matchMedia').mockReturnValue(motionQuery);
    render(<VisualizerCanvas artUrl="" artKey="" />);
    flushFrame();

    matches = true;
    act(() => {
      if (typeof motionListener === 'function') {
        motionListener({ matches: true } as MediaQueryListEvent);
      }
    });

    expect(callbacks.size).toBe(1);
    flushFrame(1_016);
    expect(hoisted.renderFrameMock).toHaveBeenLastCalledWith(
      context,
      320,
      180,
      hoisted.feed.frame,
      'bars',
      expect.objectContaining({ reducedMotion: true }),
      expect.anything(),
    );
  });

  it('coalesces canvas resize invalidations into one idle repaint', () => {
    render(<VisualizerCanvas artUrl="" artKey="" />);
    const observer = latestResizeObserver();
    expect(observer).toBeDefined();
    flushFrame();

    act(() => {
      observer?.emit();
      observer?.emit();
    });

    expect(callbacks.size).toBe(1);
    flushFrame(1_016);
    expect(hoisted.renderFrameMock).toHaveBeenCalledTimes(2);
    expect(callbacks.size).toBe(0);
  });

  it('cleans up RAF, observers, visibility listener, and feed wake subscription', () => {
    const removeEventListener = vi.spyOn(document, 'removeEventListener');
    const { unmount } = render(<VisualizerCanvas artUrl="" artKey="" />);
    const intersectionObserver = latestIntersectionObserver();
    const resizeObserver = latestResizeObserver();
    expect(hoisted.listeners.size).toBe(1);
    expect(callbacks.size).toBe(1);

    unmount();

    expect(callbacks.size).toBe(0);
    expect(hoisted.listeners.size).toBe(0);
    expect(intersectionObserver?.disconnect).toHaveBeenCalledTimes(1);
    expect(resizeObserver?.disconnect).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
  });
});
