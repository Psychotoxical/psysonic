import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { installBrowserMocks, resetBrowserMocks } from './mocks/browser';

// ─────────────────────────────────────────────────────────────────────────────
// Node 25 ships a native `localStorage` global that is broken on this
// platform — `typeof localStorage === 'object'` but `localStorage.getItem`
// is `undefined`. jsdom 26 simply forwards to it, so both globalThis and
// window expose a non-functional storage. Any code that runs
// `localStorage.getItem(...)` at module load (e.g. `i18n.ts`, `authStore.ts`)
// crashes before tests start.
//
// Fix: install a Map-backed polyfill that conforms to the DOM Storage
// interface, on both globalThis and window. Per-test isolation comes from
// the `afterEach(() => store.clear())` hook below.
// ─────────────────────────────────────────────────────────────────────────────
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(String(key), String(value));
  }
  removeItem(key: string): void {
    this.map.delete(String(key));
  }
  clear(): void {
    this.map.clear();
  }
}

const memLocal = new MemoryStorage();
const memSession = new MemoryStorage();

function installStorage(globalKey: 'localStorage' | 'sessionStorage', store: Storage) {
  try {
    Object.defineProperty(globalThis, globalKey, {
      configurable: true,
      writable: true,
      value: store,
    });
  } catch {
    /* ignore — non-configurable global */
  }
  if (typeof window !== 'undefined') {
    try {
      Object.defineProperty(window, globalKey, {
        configurable: true,
        writable: true,
        value: store,
      });
    } catch {
      /* ignore */
    }
  }
}

installStorage('localStorage', memLocal);
installStorage('sessionStorage', memSession);

// Install jsdom-gap browser API mocks (ResizeObserver / IntersectionObserver /
// matchMedia / clipboard / object URLs) so components don't crash on import.
installBrowserMocks();

// ─────────────────────────────────────────────────────────────────────────────
// Global Tauri mocks.
//
// Every test file that imports `@tauri-apps/api/core` or `@tauri-apps/api/event`
// gets these stubs. They start as bare `vi.fn()`s; the helpers in
// `src/test/mocks/tauri.ts` attach programmable implementations the first time
// they are imported by a test file. Tests that don't need Tauri can ignore
// the helpers entirely.
//
// We mock here (in setupFiles) rather than per-test-file so individual tests
// don't have to repeat `vi.mock('@tauri-apps/api/core', …)` boilerplate.
// ─────────────────────────────────────────────────────────────────────────────
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((p: string) => `tauri://localhost/${p}`),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
  // Components chain `.catch()` on emit; return a resolved Promise so the
  // chain doesn't throw "Cannot read properties of undefined (reading
  // 'catch')" inside a useEffect on first render.
  emit: vi.fn(async () => undefined),
  once: vi.fn(async () => () => {}),
}));

// Linker for Tauri shell / dialog / store plugins — same idea. Extend as needed.
vi.mock('@tauri-apps/plugin-shell', () => ({
  open: vi.fn(async () => {}),
}));

beforeEach(() => {
  resetBrowserMocks();
});

afterEach(() => {
  cleanup();
  memLocal.clear();
  memSession.clear();
});
