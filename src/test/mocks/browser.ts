/**
 * Browser API mocks for jsdom.
 *
 * jsdom ships partial implementations of some Web APIs and stubs others
 * entirely. Components that legitimately call `ResizeObserver`,
 * `IntersectionObserver`, `matchMedia`, `navigator.clipboard`, or
 * `URL.createObjectURL` need test-time implementations to avoid `is not a
 * function` failures.
 *
 * `installBrowserMocks()` is idempotent — calling it twice is harmless.
 * It is wired into setup.ts so every test file inherits the mocks; per-test
 * overrides remain possible via `vi.spyOn` on the specific mock instance.
 */
import { vi } from 'vitest';

// ─── ResizeObserver ──────────────────────────────────────────────────────────
class MockResizeObserver implements ResizeObserver {
  observe = vi.fn<(target: Element) => void>();
  unobserve = vi.fn<(target: Element) => void>();
  disconnect = vi.fn<() => void>();
}

// ─── IntersectionObserver ────────────────────────────────────────────────────
class MockIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin: string = '0px';
  readonly scrollMargin: string = '0px';
  readonly thresholds: ReadonlyArray<number> = [];
  observe = vi.fn<(target: Element) => void>();
  unobserve = vi.fn<(target: Element) => void>();
  disconnect = vi.fn<() => void>();
  takeRecords = vi.fn<() => IntersectionObserverEntry[]>(() => []);
}

// ─── matchMedia ──────────────────────────────────────────────────────────────
function makeMockMediaQueryList(query: string): MediaQueryList {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const list = {
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn((cb: (e: MediaQueryListEvent) => void) => listeners.add(cb)),
    removeListener: vi.fn((cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb)),
    addEventListener: vi.fn((_type: string, cb: EventListenerOrEventListenerObject) =>
      listeners.add(cb as (e: MediaQueryListEvent) => void),
    ),
    removeEventListener: vi.fn((_type: string, cb: EventListenerOrEventListenerObject) =>
      listeners.delete(cb as (e: MediaQueryListEvent) => void),
    ),
    dispatchEvent: vi.fn(() => true),
  } as unknown as MediaQueryList;
  return list;
}

// ─── Clipboard ───────────────────────────────────────────────────────────────
let clipboardContents = '';
const clipboardMock = {
  writeText: vi.fn(async (text: string) => {
    clipboardContents = String(text);
  }),
  readText: vi.fn(async () => clipboardContents),
};

export function getMockClipboardContents(): string {
  return clipboardContents;
}

// ─── URL.createObjectURL / revokeObjectURL ───────────────────────────────────
let objectUrlCounter = 0;
const createObjectUrlMock = vi.fn((_blob: Blob | MediaSource) => {
  objectUrlCounter += 1;
  return `blob:mock://obj-${objectUrlCounter}`;
});
const revokeObjectUrlMock = vi.fn<(url: string) => void>();

// ─── Install ─────────────────────────────────────────────────────────────────
let installed = false;

export function installBrowserMocks(): void {
  if (installed) return;
  installed = true;

  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;

  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn((query: string) => makeMockMediaQueryList(query)),
    });
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: clipboardMock,
    });
  }

  if (typeof URL !== 'undefined') {
    URL.createObjectURL = createObjectUrlMock as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectUrlMock as unknown as typeof URL.revokeObjectURL;
  }

  // jsdom lacks scrollIntoView — components that auto-scroll the queue / lists
  // crash on mount without this stub.
  if (typeof Element !== 'undefined' && !('scrollIntoView' in Element.prototype)) {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: function scrollIntoView(_opts?: ScrollIntoViewOptions | boolean) { /* no-op */ },
    });
  }
}

export function resetBrowserMocks(): void {
  clipboardContents = '';
  objectUrlCounter = 0;
  clipboardMock.writeText.mockClear();
  clipboardMock.readText.mockClear();
  createObjectUrlMock.mockClear();
  revokeObjectUrlMock.mockClear();
}

export { clipboardMock, createObjectUrlMock, revokeObjectUrlMock };
