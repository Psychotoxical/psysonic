import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadLocalNewReleasesMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/library/newReleasesLocal', () => ({
  loadLocalNewReleases: loadLocalNewReleasesMock,
}));

import {
  NEW_RELEASE_GENRE_COUNTS_DELAY_MS,
  useNewReleaseGenreCounts,
} from '@/features/album/hooks/useNewReleaseGenreCounts';

const baseArgs = {
  anchorServerId: 'server-a',
  scopes: [{ serverId: 'server-a', libraryId: 'library-a' }],
  scopeFingerprint: 'scope-a',
  musicLibraryFilterVersion: 0,
  feedReady: true,
  enabled: true,
};

describe('useNewReleaseGenreCounts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loadLocalNewReleasesMock.mockReset().mockResolvedValue({
      albums: [],
      hasMore: false,
      genreCounts: [{ value: 'Rock', albumCount: 12 }],
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('waits until after the feed is ready and the delay has elapsed', async () => {
    const view = renderHook(
      ({ feedReady }) => useNewReleaseGenreCounts({ ...baseArgs, feedReady }),
      { initialProps: { feedReady: false } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(NEW_RELEASE_GENRE_COUNTS_DELAY_MS * 2); });
    expect(loadLocalNewReleasesMock).not.toHaveBeenCalled();

    view.rerender({ feedReady: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(NEW_RELEASE_GENRE_COUNTS_DELAY_MS - 1); });
    expect(loadLocalNewReleasesMock).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(loadLocalNewReleasesMock).toHaveBeenCalledWith(
      'server-a',
      baseArgs.scopes,
      1,
      0,
      [],
      true,
    );
    expect(view.result.current).toEqual([{ genre: 'Rock', count: 12 }]);
  });

  it('cancels the delayed request when the page leaves', async () => {
    const view = renderHook(() => useNewReleaseGenreCounts(baseArgs));
    view.unmount();

    await act(async () => { await vi.advanceTimersByTimeAsync(NEW_RELEASE_GENRE_COUNTS_DELAY_MS); });
    expect(loadLocalNewReleasesMock).not.toHaveBeenCalled();
  });
});
