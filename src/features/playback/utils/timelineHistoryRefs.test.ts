import { describe, it, expect } from 'vitest';
import { bootstrapTrackFromPlaySession, timelineHistoryToQueueRefs } from '@/features/playback/utils/timelineHistoryRefs';

describe('timelineHistoryRefs', () => {
  it('maps history rows to queue refs', () => {
    expect(timelineHistoryToQueueRefs([
      { serverId: 's1', trackId: 't1', playedAtMs: 1 },
      { serverId: 's2', trackId: 't2', playedAtMs: 2 },
    ])).toEqual([
      { serverId: 's1', trackId: 't1' },
      { serverId: 's2', trackId: 't2' },
    ]);
  });

  it('seeds bootstrap tracks with album cover metadata', () => {
    const track = bootstrapTrackFromPlaySession({
      serverId: 's2',
      trackId: 't1',
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      albumId: 'al-1',
      coverArtId: 'cover-1',
      startedAtMs: 1,
      listenedSec: 30,
      completion: 'full',
    });
    expect(track.albumId).toBe('al-1');
    expect(track.coverArt).toBe('cover-1');
    expect(track.serverId).toBe('s2');
  });
});
