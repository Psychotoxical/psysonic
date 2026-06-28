import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  _resetTimelineSessionHistoryForTest,
  isTimelineBootstrapAttempted,
} from '../store/timelineSessionHistory';
import {
  _resetTimelineBootstrapInFlightForTest,
  ensureTimelineBootstrap,
} from './useTimelinePlayHistory';

vi.mock('../api/library', () => ({
  libraryGetRecentPlaySessions: vi.fn(async () => []),
  TIMELINE_HISTORY_BOOTSTRAP_LIMIT: 50,
}));

vi.mock('../utils/queue/timelineBootstrapReady', () => ({
  timelineBootstrapIndexReady: vi.fn(),
}));

vi.mock('../utils/library/queueTrackResolver', async importOriginal => {
  const actual = await importOriginal<typeof import('../utils/library/queueTrackResolver')>();
  return { ...actual, seedQueueResolver: vi.fn() };
});

import { libraryGetRecentPlaySessions } from '../api/library';
import { timelineBootstrapIndexReady } from '../utils/queue/timelineBootstrapReady';

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
