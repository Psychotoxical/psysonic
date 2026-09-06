import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigate = vi.hoisted(() => vi.fn());
const restoreMainViewportScroll = vi.hoisted(() => vi.fn());
const location = vi.hoisted(() => ({
  pathname: '/playlists/pl-1',
  search: '?server=srv-a',
  hash: '',
  state: { playlistDetailScrollTop: 864 } as unknown,
}));

vi.mock('react-router', async importOriginal => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useLocation: () => location,
  useNavigate: () => navigate,
}));

vi.mock('@/lib/navigation/restoreMainViewportScroll', () => ({
  restoreMainViewportScroll,
}));

import { usePlaylistDetailScrollRestore } from './usePlaylistDetailScrollRestore';

describe('usePlaylistDetailScrollRestore', () => {
  beforeEach(() => {
    navigate.mockReset();
    restoreMainViewportScroll.mockReset();
    restoreMainViewportScroll.mockImplementation((_scrollTop, onComplete) => {
      onComplete();
      return vi.fn();
    });
    location.state = { playlistDetailScrollTop: 864 };
  });

  it('waits until playlist content is ready', () => {
    renderHook(() => usePlaylistDetailScrollRestore(false));
    expect(restoreMainViewportScroll).not.toHaveBeenCalled();
  });

  it('restores scroll and clears the one-shot navigation state', () => {
    renderHook(() => usePlaylistDetailScrollRestore(true));
    expect(restoreMainViewportScroll).toHaveBeenCalledWith(864, expect.any(Function));
    expect(navigate).toHaveBeenCalledWith('/playlists/pl-1?server=srv-a', {
      replace: true,
      state: null,
    });
  });

  it('does not navigate when an unfinished restore is cancelled on unmount', () => {
    restoreMainViewportScroll.mockImplementation((_scrollTop, onComplete) => () => onComplete());
    const { unmount } = renderHook(() => usePlaylistDetailScrollRestore(true));

    unmount();

    expect(navigate).not.toHaveBeenCalled();
  });
});
