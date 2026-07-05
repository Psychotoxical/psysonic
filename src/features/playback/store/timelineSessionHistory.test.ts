import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  _resetTimelineSessionHistoryForTest,
  appendTimelineSessionPlay,
  applyTimelineBootstrap,
  clearTimelineSessionHistory,
  getTimelineSessionHistorySnapshot,
  isTimelineBootstrapAttempted,
  isTimelineHistoryClearedThisSession,
  markTimelineBootstrapAttempted,
  TIMELINE_APPEND_DEDUPE_MS,
  TIMELINE_MERGE_DEDUPE_MS,
} from '@/features/playback/store/timelineSessionHistory';

describe('timelineSessionHistory', () => {
  beforeEach(() => {
    _resetTimelineSessionHistoryForTest();
  });

  it('appends and dedupes within append window', () => {
    const t0 = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(t0);
    appendTimelineSessionPlay({ serverId: 's1', trackId: 'a', playedAtMs: t0 });
    appendTimelineSessionPlay({ serverId: 's1', trackId: 'a', playedAtMs: t0 + 500 });
    expect(getTimelineSessionHistorySnapshot()).toHaveLength(1);

    appendTimelineSessionPlay({ serverId: 's1', trackId: 'a', playedAtMs: t0 + TIMELINE_APPEND_DEDUPE_MS + 1 });
    expect(getTimelineSessionHistorySnapshot()).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it('seeds bootstrap when buffer empty', () => {
    applyTimelineBootstrap([
      { serverId: 's1', trackId: 'a', playedAtMs: 100 },
      { serverId: 's1', trackId: 'b', playedAtMs: 200 },
    ]);
    expect(getTimelineSessionHistorySnapshot()).toEqual([
      { serverId: 's1', trackId: 'a', playedAtMs: 100 },
      { serverId: 's1', trackId: 'b', playedAtMs: 200 },
    ]);
  });

  it('merge prepends older bootstrap rows before live appends', () => {
    appendTimelineSessionPlay({ serverId: 's1', trackId: 'live', playedAtMs: 5_000 });
    applyTimelineBootstrap([
      { serverId: 's1', trackId: 'old', playedAtMs: 1_000 },
      { serverId: 's1', trackId: 'live', playedAtMs: 5_000 - TIMELINE_MERGE_DEDUPE_MS },
      { serverId: 's1', trackId: 'mid', playedAtMs: 3_000 },
    ]);
    expect(getTimelineSessionHistorySnapshot().map(r => r.trackId)).toEqual(['old', 'mid', 'live']);
  });

  it('clear blocks bootstrap merge', () => {
    clearTimelineSessionHistory();
    expect(isTimelineHistoryClearedThisSession()).toBe(true);
    applyTimelineBootstrap([{ serverId: 's1', trackId: 'a', playedAtMs: 1 }]);
    expect(getTimelineSessionHistorySnapshot()).toHaveLength(0);
  });

  it('bootstrap attempted only once', () => {
    expect(markTimelineBootstrapAttempted()).toBe(true);
    expect(markTimelineBootstrapAttempted()).toBe(false);
    expect(isTimelineBootstrapAttempted()).toBe(true);
  });
});
