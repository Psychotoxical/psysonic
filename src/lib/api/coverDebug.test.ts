import { beforeEach, describe, expect, it } from 'vitest';
import { onInvoke } from '@/test/mocks/tauri';
import { useAuthStore } from '@/store/authStore';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { emitCoverDebug } from './coverDebug';

beforeEach(resetAuthStore);

describe('emitCoverDebug', () => {
  it('writes cover diagnostics only at debug depth 3', () => {
    const captured: Array<{ scope: string; message: string }> = [];
    onInvoke('frontend_debug_log', args => {
      captured.push(args as { scope: string; message: string });
      return undefined;
    });

    emitCoverDebug('normal_skip', { value: 1 });
    useAuthStore.setState({ loggingMode: 'debug' });
    emitCoverDebug('depth_one_skip', { value: 2 });
    useAuthStore.setState({ debugLoggingDepth: 3 });
    emitCoverDebug('mf_album_slot_ensure', { cacheEntityId: 'mf-x' });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.scope).toBe('cover');
    expect(JSON.parse(captured[0]?.message ?? '{}')).toMatchObject({
      step: 'mf_album_slot_ensure',
      details: { cacheEntityId: 'mf-x' },
    });
  });
});
