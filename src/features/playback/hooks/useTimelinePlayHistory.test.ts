import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  _resetTimelineSessionHistoryForTest,
  isTimelineBootstrapAttempted,
} from '@/features/playback/store/timelineSessionHistory';
import {
  _resetTimelineBootstrapInFlightForTest,
  ensureTimelineBootstrap,
} from '@/features/playback/hooks/useTimelinePlayHistory';

vi.mock('@/lib/api/library', () => ({
  libraryGetRecentPlaySessions: vi.fn(async () => []),
  TIMELINE_HISTORY_BOOTSTRAP_LIMIT: 50,
}));

vi.mock('@/features/playback/utils/timelineBootstrapReady', () => ({
  timelineBootstrapIndexReady: vi.fn(),
}));

vi.mock('@/features/playback/store/queueTrackResolver', async importOriginal => {
  const actual = await importOriginal<typeof import('@/features/playback/store/queueTrackResolver')>();
  return { ...actual, seedQueueResolver: vi.fn() };
});

import { libraryGetRecentPlaySessions } from '@/lib/api/library';
import { timelineBootstrapIndexReady } from '@/features/playback/utils/timelineBootstrapReady';

describe('ensureTimelineBootstrap', () => {
  beforeEach(() => {
    _resetTimelineSessionHistoryForTest();
    _resetTimelineBootstrapInFlightForTest();
    vi.mocked(timelineBootstrapIndexReady).mockReset();
    vi.mocked(libraryGetRecentPlaySessions).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('defers without marking attempted when the index is not ready', async () => {
    vi.mocked(timelineBootstrapIndexReady).mockResolvedValue(false);
    await ensureTimelineBootstrap();
    expect(isTimelineBootstrapAttempted()).toBe(false);
    expect(libraryGetRecentPlaySessions).not.toHaveBeenCalled();
  });

  it('fetches once when the index is ready', async () => {
    vi.mocked(timelineBootstrapIndexReady).mockResolvedValue(true);
    await ensureTimelineBootstrap();
    expect(isTimelineBootstrapAttempted()).toBe(true);
    expect(libraryGetRecentPlaySessions).toHaveBeenCalledTimes(1);
  });

  it('does not fetch twice in the same session', async () => {
    vi.mocked(timelineBootstrapIndexReady).mockResolvedValue(true);
    await ensureTimelineBootstrap();
    await ensureTimelineBootstrap();
    expect(libraryGetRecentPlaySessions).toHaveBeenCalledTimes(1);
  });
});
