/**
 * Tests for the pre-React bootstrap orchestrator.
 *
 * Each step is wrapped in a try/catch so a non-Tauri runtime never breaks
 * startup; the tests pin both the happy path (invoke called with the right
 * payload) and the failure-tolerant path (no throw when invoke or storage
 * misbehaves).
 */
import { installQueueUndoHotkey } from '../store/queueUndoHotkey';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('../store/queueUndoHotkey', () => ({
  installQueueUndoHotkey: vi.fn(),
}));

vi.mock('./windowKind', () => ({
  getWindowKind: vi.fn(() => 'main'),
}));

import { invoke } from '@tauri-apps/api/core';
import { getWindowKind } from './windowKind';
import {
  pushLoggingModeToBackend,
  pushUserAgentToBackend,
  runPreReactBootstrap,
} from './bootstrap';

const ORIGINAL_USER_AGENT = window.navigator.userAgent;

function setUserAgent(ua: string): void {
  Object.defineProperty(window.navigator, 'userAgent', {
    value: ua,
    configurable: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockResolvedValue(undefined);
  vi.mocked(getWindowKind).mockReturnValue('main');
  localStorage.clear();
  setUserAgent('psysonic-test-ua/1.0');
});

afterEach(() => {
  setUserAgent(ORIGINAL_USER_AGENT);
});

describe('pushUserAgentToBackend', () => {
  it('forwards the navigator UA to the backend on the main window', () => {
    pushUserAgentToBackend();
    expect(invoke).toHaveBeenCalledWith('set_subsonic_wire_user_agent', {
      userAgent: 'psysonic-test-ua/1.0',
      windowLabel: 'main',
    });
  });

  it('skips the call entirely when the current window is the mini player', () => {
    vi.mocked(getWindowKind).mockReturnValue('mini');
    pushUserAgentToBackend();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('skips when the navigator UA is empty', () => {
    setUserAgent('');
    pushUserAgentToBackend();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not throw when invoke rejects (non-Tauri runtime)', () => {
    vi.mocked(invoke).mockRejectedValue(new Error('not tauri'));
    expect(() => pushUserAgentToBackend()).not.toThrow();
  });
});

describe('pushLoggingModeToBackend', () => {
  it('forwards a valid persisted loggingMode to set_logging_mode', () => {
    localStorage.setItem(
      'psysonic-auth',
      JSON.stringify({ state: { loggingMode: 'debug' } }),
    );
    pushLoggingModeToBackend();
    expect(invoke).toHaveBeenCalledWith('set_logging_mode', { mode: 'debug' });
  });

  it.each(['off', 'normal', 'debug'])('accepts mode=%s', mode => {
    localStorage.setItem('psysonic-auth', JSON.stringify({ state: { loggingMode: mode } }));
    pushLoggingModeToBackend();
    expect(invoke).toHaveBeenCalledWith('set_logging_mode', { mode });
  });

  it('skips when no psysonic-auth entry is present', () => {
    pushLoggingModeToBackend();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('skips an unknown mode value', () => {
    localStorage.setItem(
      'psysonic-auth',
      JSON.stringify({ state: { loggingMode: 'verbose' } }),
    );
    pushLoggingModeToBackend();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('skips when state.loggingMode is missing', () => {
    localStorage.setItem('psysonic-auth', JSON.stringify({ state: {} }));
    pushLoggingModeToBackend();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not throw on malformed JSON', () => {
    localStorage.setItem('psysonic-auth', '{not json');
    expect(() => pushLoggingModeToBackend()).not.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('runPreReactBootstrap', () => {
  it('runs all steps in order: warm window-kind cache, push UA, push logging mode, install hotkey', () => {
    localStorage.setItem(
      'psysonic-auth',
      JSON.stringify({ state: { loggingMode: 'normal' } }),
    );

    runPreReactBootstrap();

    expect(getWindowKind).toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('set_subsonic_wire_user_agent', expect.any(Object));
    expect(invoke).toHaveBeenCalledWith('set_logging_mode', { mode: 'normal' });
    expect(installQueueUndoHotkey).toHaveBeenCalledTimes(1);
  });

  it('still installs the hotkey on the mini window even though UA push is skipped', () => {
    vi.mocked(getWindowKind).mockReturnValue('mini');
    runPreReactBootstrap();
    expect(installQueueUndoHotkey).toHaveBeenCalledTimes(1);
    // installQueueUndoHotkey itself early-returns inside playerStore on mini —
    // the bootstrap doesn't second-guess that decision.
  });
});
