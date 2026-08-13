import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  showMainWindow: vi.fn(async () => undefined),
  openSongInfo: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'main' }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: vi.fn(async () => undefined),
  listen: vi.fn(async (event: string, listener: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(event, listener);
    return () => mocks.listeners.delete(event);
  }),
}));

vi.mock('@/lib/api/miniPlayer', () => ({
  showMainWindow: mocks.showMainWindow,
}));

vi.mock('@/features/playback/store/playerStore', () => ({
  usePlayerStore: {
    subscribe: () => () => {},
    getState: () => ({
      currentTrack: null,
      queueItems: [],
      queueIndex: 0,
      queueServerId: null,
      isPlaying: false,
      volume: 1,
      togglePlay: vi.fn(),
      next: vi.fn(),
      previous: vi.fn(),
      openSongInfo: mocks.openSongInfo,
    }),
  },
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: {
    subscribe: () => () => {},
    getState: () => ({
      gaplessEnabled: false,
      crossfadeEnabled: false,
      crossfadeSecs: 3,
      crossfadeTrimSilence: false,
      infiniteQueueEnabled: false,
    }),
  },
}));

vi.mock('@/features/playback/utils/playback/playbackTransition', () => ({
  setTransitionMode: vi.fn(),
}));

vi.mock('@/features/playback/store/queueTrackView', () => ({
  resolveQueueTrack: vi.fn(),
}));

vi.mock('@/features/miniPlayer/utils/miniTrackInfo', () => ({
  toMini: vi.fn(),
}));

import { initMiniPlayerBridgeOnMain } from './miniPlayerBridge';

describe('miniPlayerBridge main-window restore', () => {
  beforeEach(() => {
    mocks.listeners.clear();
    mocks.showMainWindow.mockReset().mockResolvedValue(undefined);
    mocks.openSongInfo.mockReset();
  });

  it('uses the fenced native restore command for every mini-to-main action', async () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const cleanup = initMiniPlayerBridgeOnMain();
    await vi.waitFor(() => expect(mocks.listeners.size).toBeGreaterThan(0));

    mocks.listeners.get('mini:control')?.({ payload: 'show-main' });
    mocks.listeners.get('mini:navigate')?.({ payload: { to: '/albums/1' } });
    mocks.listeners.get('mini:song-info')?.({ payload: { id: 'song-1', serverId: 'server-1' } });

    expect(mocks.showMainWindow).toHaveBeenCalledTimes(3);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'psy:navigate' }));
    expect(mocks.openSongInfo).toHaveBeenCalledWith('song-1', 'server-1');
    cleanup();
  });
});
