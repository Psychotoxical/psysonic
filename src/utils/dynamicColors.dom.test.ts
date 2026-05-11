/**
 * DOM-touching tests for `dynamicColors.ts` — orchestrator paths in
 * `extractCoverColors` that exercise the Image / canvas / fetch surfaces.
 *
 * jsdom ships HTMLImageElement but does not fire onload/onerror; canvas
 * `getContext('2d')` returns null. We swap in lightweight mocks so the
 * orchestrator's branch logic gets covered without a real browser.
 *
 * Pure-math helpers live in `dynamicColors.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractCoverColors } from './dynamicColors';

type ImageBehavior = 'load' | 'error';

interface MockImageHandle {
  setBehavior(b: ImageBehavior): void;
}

function installImageMock(): MockImageHandle {
  let behavior: ImageBehavior = 'load';
  const original = globalThis.Image;

  class MockImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    crossOrigin = '';
    private _src = '';
    get src() { return this._src; }
    set src(v: string) {
      this._src = v;
      queueMicrotask(() => {
        if (behavior === 'load') this.onload?.();
        else this.onerror?.();
      });
    }
  }

  globalThis.Image = MockImage as unknown as typeof Image;
  return {
    setBehavior(b: ImageBehavior) { behavior = b; },
    [Symbol.dispose]: () => { globalThis.Image = original; },
  } as MockImageHandle;
}

function installCanvasContextMock(opts: { tainted?: boolean } = {}): () => void {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, _id: string) {
    if (opts.tainted) {
      return {
        drawImage: vi.fn(),
        getImageData: vi.fn(() => {
          throw new Error('tainted canvas');
        }),
      } as unknown as CanvasRenderingContext2D;
    }
    // Return a context with a fixed 8x8 image where every pixel is a vibrant
    // orange — the saturation pick will land on it, exercising the
    // sampleImageToAccent loop.
    const data = new Uint8ClampedArray(8 * 8 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 230;     // R
      data[i + 1] = 110; // G
      data[i + 2] = 30;  // B
      data[i + 3] = 255; // A
    }
    return {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data, width: 8, height: 8 })),
    } as unknown as CanvasRenderingContext2D;
  } as typeof HTMLCanvasElement.prototype.getContext;
  return () => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  };
}

describe('extractCoverColors — early returns', () => {
  it('returns empty for an empty URL', async () => {
    expect(await extractCoverColors('')).toEqual({ accent: '' });
  });

  it('returns empty for the bundled logo (avoids self-tinting)', async () => {
    expect(await extractCoverColors('/assets/logo-psysonic-256.png')).toEqual({ accent: '' });
  });
});

describe('extractCoverColors — blob: URL', () => {
  let imageMock: MockImageHandle;
  let restoreCanvas: () => void;

  beforeEach(() => {
    imageMock = installImageMock();
    restoreCanvas = installCanvasContextMock();
  });

  afterEach(() => {
    (imageMock as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
    restoreCanvas();
  });

  it('returns an accent on a successful sample', async () => {
    imageMock.setBehavior('load');
    const result = await extractCoverColors('blob:fake/abc-123');
    expect(result.accent).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
  });

  it('returns empty when image load fails', async () => {
    imageMock.setBehavior('error');
    const result = await extractCoverColors('blob:fake/oops');
    expect(result).toEqual({ accent: '' });
  });

  it('returns empty when the canvas is tainted', async () => {
    imageMock.setBehavior('load');
    restoreCanvas(); // swap to tainted canvas
    restoreCanvas = installCanvasContextMock({ tainted: true });
    const result = await extractCoverColors('blob:fake/tainted');
    expect(result).toEqual({ accent: '' });
  });

  it('returns empty when getContext returns null', async () => {
    imageMock.setBehavior('load');
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
    try {
      const result = await extractCoverColors('blob:fake/no-ctx');
      expect(result).toEqual({ accent: '' });
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
    }
  });
});

describe('extractCoverColors — remote http(s) URL', () => {
  let imageMock: MockImageHandle;
  let restoreCanvas: () => void;
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    imageMock = installImageMock();
    restoreCanvas = installCanvasContextMock();
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    (imageMock as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
    restoreCanvas();
    globalThis.fetch = originalFetch;
  });

  it('fetches the blob, samples, and revokes the object URL', async () => {
    imageMock.setBehavior('load');
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    fetchMock.mockResolvedValue({ ok: true, blob: async () => blob } as Response);

    const result = await extractCoverColors('https://music.example.com/cover.png');

    expect(result.accent).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
    expect(fetchMock).toHaveBeenCalledWith('https://music.example.com/cover.png');
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it('falls back to crossOrigin=anonymous when fetch fails', async () => {
    imageMock.setBehavior('load');
    fetchMock.mockRejectedValue(new Error('CORS blocked'));

    const result = await extractCoverColors('https://music.example.com/cover.png');
    // Anonymous-CORS image load succeeds in the mock → still samples.
    expect(result.accent).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
  });

  it('falls back to crossOrigin=anonymous when fetch returns !ok', async () => {
    imageMock.setBehavior('load');
    fetchMock.mockResolvedValue({ ok: false, blob: async () => new Blob() } as Response);

    const result = await extractCoverColors('https://music.example.com/cover.png');
    expect(result.accent).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
  });

  it('returns empty when both fetch and the anonymous fallback fail', async () => {
    imageMock.setBehavior('error');
    fetchMock.mockRejectedValue(new Error('network down'));

    const result = await extractCoverColors('https://music.example.com/cover.png');
    expect(result).toEqual({ accent: '' });
  });
});

describe('extractCoverColors — other URL shapes', () => {
  let imageMock: MockImageHandle;
  let restoreCanvas: () => void;

  beforeEach(() => {
    imageMock = installImageMock();
    restoreCanvas = installCanvasContextMock();
  });

  afterEach(() => {
    (imageMock as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
    restoreCanvas();
  });

  it('handles a data: URL through the same blob-or-data path', async () => {
    imageMock.setBehavior('load');
    const result = await extractCoverColors('data:image/png;base64,iVBORw0KGgo=');
    expect(result.accent).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
  });

  it('handles a relative path as a direct image load', async () => {
    imageMock.setBehavior('load');
    const result = await extractCoverColors('/local/cover.jpg');
    expect(result.accent).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
  });
});
