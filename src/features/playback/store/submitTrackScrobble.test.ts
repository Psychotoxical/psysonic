import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTrack } from '@/test/helpers/factories';

const scrobbleSong = vi.hoisted(() => vi.fn());
const dispatchScrobble = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@/lib/api/subsonicScrobble', () => ({
  scrobbleSong,
}));

vi.mock('@/music-network', () => ({
  getMusicNetworkRuntimeOrNull: () => ({ dispatchScrobble }),
}));

vi.mock('@/features/playback/utils/playback/playbackServer', () => ({
  playbackProfileIdForTrack: (track: { serverId?: string }, ref?: { serverId?: string }) =>
    ref?.serverId ?? track.serverId ?? '',
}));

import { submitTrackScrobble } from './submitTrackScrobble';

beforeEach(() => {
  scrobbleSong.mockClear();
  dispatchScrobble.mockClear();
});

describe('submitTrackScrobble', () => {
  it('sends the play to the owning server and Music Network', () => {
    const track = makeTrack({ id: 't1', title: 'Song', artist: 'A', album: 'B', duration: 200, serverId: 'srv-a' });
    submitTrackScrobble(track, 'srv-queue', 1234);

    expect(scrobbleSong).toHaveBeenCalledWith('t1', 1234, 'srv-queue');
    expect(dispatchScrobble).toHaveBeenCalledWith({
      title: 'Song',
      artist: 'A',
      album: 'B',
      duration: 200,
      timestamp: 1234,
    });
  });
});
