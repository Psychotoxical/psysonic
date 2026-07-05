import { beforeEach, describe, expect, it } from 'vitest';
import {
  fingerprintFromLocalQueue,
  fingerprintFromServer,
  playQueueFingerprintsEqual,
} from '@/features/playback/store/applyServerPlayQueue';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { resetPlayerStore } from '@/test/helpers/storeReset';

describe('playQueueFingerprintsEqual', () => {
  beforeEach(() => {
    resetPlayerStore();
  });

  it('compares track order, current id, and position within tolerance', () => {
    const a = { trackIds: ['1', '2'], currentId: '1', positionMs: 1000 };
    const b = { trackIds: ['1', '2'], currentId: '1', positionMs: 2500 };
    expect(playQueueFingerprintsEqual(a, b)).toBe(true);
    expect(playQueueFingerprintsEqual(a, { ...b, positionMs: 4000 })).toBe(false);
  });

  it('fingerprintFromLocalQueue reads the player store', () => {
    usePlayerStore.setState({
      queueItems: [{ serverId: 'a.test', trackId: 't1' }],
      currentTrack: { id: 't1', title: 'T', artist: '', album: 'A', albumId: 'al', duration: 60 },
      currentTime: 3.5,
    });
    expect(fingerprintFromLocalQueue()).toEqual({
      trackIds: ['t1'],
      currentId: 't1',
      positionMs: 3500,
    });
  });

  it('fingerprintFromServer maps Subsonic playQueue fields', () => {
    expect(fingerprintFromServer({
      songs: [{ id: 'a' }, { id: 'b' }] as never,
      current: 'b',
      position: 1200,
    })).toEqual({
      trackIds: ['a', 'b'],
      currentId: 'b',
      positionMs: 1200,
    });
  });
});
