import { describe, expect, it, beforeEach } from 'vitest';
import { onInvoke } from '@/test/mocks/tauri';
import { useAuthStore } from '@/store/authStore';
import { emitLiveSearchDebug } from './liveSearchDebug';

describe('emitLiveSearchDebug', () => {
  beforeEach(() => {
    useAuthStore.setState({ loggingMode: 'normal' });
  });

  it('forwards JSON to frontend_debug_log in debug mode', () => {
    useAuthStore.setState({ loggingMode: 'debug' });
    let captured: unknown;
    onInvoke('frontend_debug_log', args => {
      captured = args;
      return undefined;
    });
    emitLiveSearchDebug('race_winner', { query: 'metal', winner: 'network' });
    expect(captured).toEqual({
      scope: 'live-search',
      message: JSON.stringify({
        step: 'race_winner',
        details: { query: 'metal', winner: 'network' },
      }),
    });
  });

  it('is a no-op when logging mode is not debug', () => {
    let invoked = false;
    onInvoke('frontend_debug_log', () => {
      invoked = true;
      return undefined;
    });
    emitLiveSearchDebug('race_winner', { query: 'x' });
    expect(invoked).toBe(false);
  });
});
