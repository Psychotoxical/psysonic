import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authState, invokeMock } = vi.hoisted(() => ({
  authState: { loggingMode: 'off' as 'off' | 'debug' | string },
  invokeMock: vi.fn(async (_cmd: string, _args?: Record<string, unknown>) => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('./authStore', () => ({ useAuthStore: { getState: () => authState } }));

import { emitNormalizationDebug } from './normalizationDebug';

beforeEach(() => {
  authState.loggingMode = 'off';
  invokeMock.mockClear();
  invokeMock.mockResolvedValue(undefined);
});

describe('emitNormalizationDebug', () => {
  it('is a no-op when logging mode is not debug', () => {
    emitNormalizationDebug('refresh:start', { trackId: 't1' });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('forwards a JSON payload to frontend_debug_log in debug mode', () => {
    authState.loggingMode = 'debug';
    emitNormalizationDebug('refresh:start', { trackId: 't1' });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = invokeMock.mock.calls[0];
    expect(cmd).toBe('frontend_debug_log');
    expect(args).toMatchObject({
      scope: 'normalization',
      message: JSON.stringify({ step: 'refresh:start', details: { trackId: 't1' } }),
    });
  });

  it('serializes calls without details too', () => {
    authState.loggingMode = 'debug';
    emitNormalizationDebug('plain-step');
    const args = invokeMock.mock.calls[0][1] as { message: string };
    expect(JSON.parse(args.message)).toEqual({ step: 'plain-step' });
  });

  it('swallows invoke rejections (best-effort instrumentation)', async () => {
    authState.loggingMode = 'debug';
    invokeMock.mockRejectedValueOnce(new Error('rust busy'));
    expect(() => emitNormalizationDebug('refresh:start')).not.toThrow();
    // Give the rejected promise a tick to settle without throwing.
    await Promise.resolve();
  });
});
