import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type StartupInternals = {
  invoke: ReturnType<typeof vi.fn>;
};

describe('startup splash native reveal', () => {
  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: StartupInternals }).__TAURI_INTERNALS__;
    delete window.__psyUseCustomTitlebar;
    delete window.__psyIsTilingWm;
    delete window.__psyStartMinimizedToTray;
    vi.unstubAllGlobals();
  });

  it('prepares the final title-bar mode before showing the window', async () => {
    localStorage.setItem('psysonic-auth', JSON.stringify({
      state: { useCustomTitlebar: true, startMinimizedToTray: false },
    }));
    const invoke = vi.fn(async (command: string) => command === 'prepare_main_window_for_reveal');
    (window as Window & { __TAURI_INTERNALS__?: StartupInternals }).__TAURI_INTERNALS__ = { invoke };
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    window.eval(readFileSync(resolve(process.cwd(), 'public/startup-splash-preflight.js'), 'utf8'));
    window.eval(readFileSync(resolve(process.cwd(), 'public/startup-splash-reveal.js'), 'utf8'));

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(invoke.mock.calls[0]).toEqual([
      'prepare_main_window_for_reveal',
      { useCustomTitlebar: true },
    ]);
    expect(invoke.mock.calls[1]).toEqual(['plugin:window|show', { label: 'main' }]);
    expect(window.__psyIsTilingWm).toBe(true);
  });
});
