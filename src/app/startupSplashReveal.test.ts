import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type StartupInternals = {
  invoke: ReturnType<typeof vi.fn>;
};

describe('startup splash native reveal', () => {
  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: StartupInternals }).__TAURI_INTERNALS__;
    delete window.__psyIsTilingWm;
    delete window.__psyStartMinimizedToTray;
    delete window.__psyLifecycleGeneration;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows a hidden startup window without waiting for requestAnimationFrame', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'window_lifecycle_generation') return 4;
      return command === 'prepare_main_window_for_reveal';
    });
    (window as Window & { __TAURI_INTERNALS__?: StartupInternals }).__TAURI_INTERNALS__ = { invoke };
    vi.stubGlobal('requestAnimationFrame', () => {
      throw new Error('requestAnimationFrame must not gate native show');
    });

    window.eval(readFileSync(resolve(process.cwd(), 'public/startup-splash-preflight.js'), 'utf8'));
    window.eval(readFileSync(resolve(process.cwd(), 'public/startup-splash-reveal.js'), 'utf8'));

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
    expect(invoke.mock.calls[0]).toEqual(['window_lifecycle_generation']);
    expect(invoke.mock.calls[1]).toEqual(['prepare_main_window_for_reveal', { generation: 4 }]);
    expect(invoke.mock.calls[2]).toEqual(['window_lifecycle_startup_visibility', {
      hidden: false,
      generation: 4,
    }]);
    expect(window.__psyIsTilingWm).toBe(true);
  });

  it('prepares before hiding a start-minimized window', async () => {
    localStorage.setItem('psysonic-auth', JSON.stringify({
      state: { startMinimizedToTray: true, showTrayIcon: true },
    }));
    const invoke = vi.fn(async (command: string) => command === 'window_lifecycle_generation' ? 4 : false);
    (window as Window & { __TAURI_INTERNALS__?: StartupInternals }).__TAURI_INTERNALS__ = { invoke };

    window.eval(readFileSync(resolve(process.cwd(), 'public/startup-splash-preflight.js'), 'utf8'));
    window.eval(readFileSync(resolve(process.cwd(), 'public/startup-splash-reveal.js'), 'utf8'));

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
    expect(invoke.mock.calls[0]).toEqual(['window_lifecycle_generation']);
    expect(invoke.mock.calls[1]).toEqual(['prepare_main_window_for_reveal', { generation: 4 }]);
    expect(invoke.mock.calls[2]).toEqual(['window_lifecycle_startup_visibility', {
      hidden: true,
      generation: 4,
    }]);
    expect(window.__psyHidden).toBe(true);
  });

  it('shows the window through the native fallback when preparation hangs', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const invoke = vi.fn((command: string) => {
      if (command === 'window_lifecycle_generation') return Promise.resolve(4);
      if (command === 'prepare_main_window_for_reveal') return new Promise(() => {});
      return Promise.resolve();
    });
    (window as Window & { __TAURI_INTERNALS__?: StartupInternals }).__TAURI_INTERNALS__ = { invoke };
    window.eval(readFileSync(resolve(process.cwd(), 'public/startup-splash-preflight.js'), 'utf8'));
    window.eval(readFileSync(resolve(process.cwd(), 'public/startup-splash-reveal.js'), 'utf8'));
    await vi.advanceTimersByTimeAsync(1500);

    expect(invoke).toHaveBeenCalledWith('window_lifecycle_startup_visibility', {
      hidden: false,
      generation: 4,
    });
    expect(warn).toHaveBeenCalled();
  });

  it('bounds failed native show retries', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const invoke = vi.fn((command: string) => {
      if (command === 'window_lifecycle_generation') return Promise.resolve(4);
      if (command === 'prepare_main_window_for_reveal') return Promise.resolve(false);
      return Promise.reject(new Error('show failed'));
    });
    (window as Window & { __TAURI_INTERNALS__?: StartupInternals }).__TAURI_INTERNALS__ = { invoke };
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    window.eval(readFileSync(resolve(process.cwd(), 'public/startup-splash-preflight.js'), 'utf8'));
    window.eval(readFileSync(resolve(process.cwd(), 'public/startup-splash-reveal.js'), 'utf8'));
    await vi.runAllTimersAsync();

    expect(invoke.mock.calls.filter(([command]) => command === 'prepare_main_window_for_reveal')).toHaveLength(1);
    expect(invoke.mock.calls.filter(([command]) => command === 'window_lifecycle_startup_visibility')).toHaveLength(3);
  });

  it('does not overlap a timed-out show with another visibility mutation', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const invoke = vi.fn((command: string) => {
      if (command === 'window_lifecycle_generation') return Promise.resolve(4);
      if (command === 'prepare_main_window_for_reveal') return Promise.resolve(false);
      return new Promise(() => {});
    });
    (window as Window & { __TAURI_INTERNALS__?: StartupInternals }).__TAURI_INTERNALS__ = { invoke };

    window.eval(readFileSync(resolve(process.cwd(), 'public/startup-splash-preflight.js'), 'utf8'));
    window.eval(readFileSync(resolve(process.cwd(), 'public/startup-splash-reveal.js'), 'utf8'));
    await vi.advanceTimersByTimeAsync(1600);

    expect(invoke.mock.calls.filter(([command]) => command === 'window_lifecycle_startup_visibility')).toHaveLength(1);
  });

  it('does not fall back to an unfenced visibility command without a generation', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const invoke = vi.fn(() => Promise.reject(new Error('generation unavailable')));
    (window as Window & { __TAURI_INTERNALS__?: StartupInternals }).__TAURI_INTERNALS__ = { invoke };

    window.eval(readFileSync(resolve(process.cwd(), 'public/startup-splash-preflight.js'), 'utf8'));
    window.eval(readFileSync(resolve(process.cwd(), 'public/startup-splash-reveal.js'), 'utf8'));
    await vi.runAllTimersAsync();

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('window_lifecycle_generation');
  });
});
