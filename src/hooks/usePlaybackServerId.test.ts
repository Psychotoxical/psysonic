import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '../store/playerStore';
import { usePlaybackServerId } from './usePlaybackServerId';

vi.mock('../utils/server/switchActiveServer', () => ({
  switchActiveServer: vi.fn(async () => true),
}));

describe('usePlaybackServerId', () => {
  beforeEach(() => {
    useAuthStore.setState({
      servers: [
        { id: 'a', name: 'A', url: 'http://a.test', username: 'u', password: 'p' },
        { id: 'b', name: 'B', url: 'http://b.test', username: 'u', password: 'p' },
      ],
      activeServerId: 'a',
      isLoggedIn: true,
    });
    usePlayerStore.setState({
      queueItems: [{ serverId: 'a', trackId: 't1' }],
      queueServerId: 'a',
      queueIndex: 0,
    });
  });

  it('returns queue server while playback queue is non-empty', () => {
    useAuthStore.setState({ activeServerId: 'b' });
    const { result } = renderHook(() => usePlaybackServerId());
    expect(result.current).toBe('a');
  });

  it('does not call switchActiveServer when browsed server changes', async () => {
    const { switchActiveServer } = await import('../utils/server/switchActiveServer');
    vi.mocked(switchActiveServer).mockClear();
    const { rerender } = renderHook(() => usePlaybackServerId());
    useAuthStore.setState({ activeServerId: 'b' });
    rerender();
    expect(switchActiveServer).not.toHaveBeenCalled();
  });
});
