import { describe, expect, it } from 'vitest';
import { nowPlayingPresence, NOW_PLAYING_IDLE_MINUTES } from '@/features/nowPlaying/api/nowPlayingPresence';
import type { SubsonicNowPlaying, PlaybackReportState } from '@/lib/api/subsonicTypes';

// The function only reads `state` and `minutesAgo`; cast a minimal fixture.
function entry(partial: { state?: PlaybackReportState; minutesAgo?: number }): SubsonicNowPlaying {
  return { minutesAgo: 0, ...partial } as SubsonicNowPlaying;
}

describe('nowPlayingPresence', () => {
  it('maps live playbackReport state authoritatively', () => {
    expect(nowPlayingPresence(entry({ state: 'playing' }))).toBe('playing');
    expect(nowPlayingPresence(entry({ state: 'starting' }))).toBe('playing');
    expect(nowPlayingPresence(entry({ state: 'paused' }))).toBe('paused');
    expect(nowPlayingPresence(entry({ state: 'stopped' }))).toBe('idle');
  });

  it('live state wins over a stale minutesAgo', () => {
    // A paused session last reported minutes ago is still "paused", not idle.
    expect(nowPlayingPresence(entry({ state: 'paused', minutesAgo: 99 }))).toBe('paused');
    expect(nowPlayingPresence(entry({ state: 'playing', minutesAgo: 99 }))).toBe('playing');
  });

  it('falls back to recency for legacy entries without a state', () => {
    expect(nowPlayingPresence(entry({ minutesAgo: 0 }))).toBe('playing');
    expect(nowPlayingPresence(entry({ minutesAgo: NOW_PLAYING_IDLE_MINUTES }))).toBe('playing');
    expect(nowPlayingPresence(entry({ minutesAgo: NOW_PLAYING_IDLE_MINUTES + 1 }))).toBe('idle');
  });
});
