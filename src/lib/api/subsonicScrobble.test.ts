import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import {
  getNowPlayingForServer,
  getNowPlayingForServers,
  reportNowPlaying,
  scrobbleSong,
} from '@/lib/api/subsonicScrobble';
import { shouldAttemptSubsonicForServer } from '@/lib/network/subsonicNetworkGuard';

const { apiForServerMock, patchTrackMock } = vi.hoisted(() => ({
  apiForServerMock: vi.fn(async (
    _serverId?: string,
    _endpoint?: string,
    _params?: Record<string, unknown>,
  ): Promise<unknown> => ({})),
  patchTrackMock: vi.fn(),
}));

vi.mock('@/lib/api/subsonicClient', () => ({
  api: vi.fn(),
  apiForServer: apiForServerMock,
}));
vi.mock('@/lib/network/subsonicNetworkGuard', () => ({
  shouldAttemptSubsonicForServer: vi.fn(() => true),
}));
vi.mock('@/lib/library/patchOnUse', () => ({
  patchLibraryTrackOnUse: patchTrackMock,
}));

describe('subsonicScrobble', () => {
  beforeEach(() => {
    apiForServerMock.mockClear();
    apiForServerMock.mockResolvedValue({});
    patchTrackMock.mockClear();
    vi.mocked(shouldAttemptSubsonicForServer).mockImplementation(() => true);
    useAuthStore.setState({
      servers: [
        { id: 'a', name: 'A', url: 'http://a.test', username: 'u', password: 'p' },
        { id: 'b', name: 'B', url: 'http://b.test', username: 'u', password: 'p' },
      ],
      activeServerId: 'b',
      isLoggedIn: true,
    });
    usePlayerStore.setState({
      queueItems: [{ serverId: 'a', trackId: 't1' }],
      queueServerId: 'a',
      queueIndex: 0,
    });
  });

  it('scrobbleSong targets the queue server when active server differs', async () => {
    await scrobbleSong('t1', 1_700_000_000_000, 'a');
    expect(apiForServerMock).toHaveBeenCalledWith(
      'a',
      'scrobble.view',
      expect.objectContaining({ id: 't1', submission: true, time: 1_700_000_000_000 }),
    );
  });

  it('reportNowPlaying and scrobbleSong use the presence guard without trackId', async () => {
    vi.mocked(shouldAttemptSubsonicForServer).mockImplementation(
      (_serverId: string, trackId?: string) => trackId === undefined,
    );

    await reportNowPlaying('t-local', 'a');
    await scrobbleSong('t-local', 1_700_000_000_000, 'a');

    expect(shouldAttemptSubsonicForServer).toHaveBeenCalledWith('a');
    expect(shouldAttemptSubsonicForServer).not.toHaveBeenCalledWith('a', expect.anything());
    expect(apiForServerMock).toHaveBeenCalledTimes(2);
    expect(apiForServerMock).toHaveBeenNthCalledWith(
      1,
      'a',
      'scrobble.view',
      expect.objectContaining({ id: 't-local', submission: false }),
    );
    expect(apiForServerMock).toHaveBeenNthCalledWith(
      2,
      'a',
      'scrobble.view',
      expect.objectContaining({ id: 't-local', submission: true }),
    );
  });

  it('annotates now-playing entries with their owning server', async () => {
    apiForServerMock.mockResolvedValueOnce({
      nowPlaying: { entry: { id: 't1', title: 'One', username: 'alice' } },
    });
    await expect(getNowPlayingForServer('a')).resolves.toEqual([
      expect.objectContaining({ id: 't1', username: 'alice', serverId: 'a' }),
    ]);
  });

  it('aggregates selected servers in scope order and tolerates partial failure', async () => {
    apiForServerMock.mockImplementation(async (serverId?: string) => {
      if (serverId === 'b') throw new Error('offline');
      return { nowPlaying: { entry: [{ id: `${serverId}-1`, title: serverId, username: 'listener' }] } };
    });

    await expect(getNowPlayingForServers(['a', 'b', 'a'])).resolves.toEqual([
      expect.objectContaining({ id: 'a-1', serverId: 'a' }),
    ]);
    expect(apiForServerMock).toHaveBeenCalledTimes(2);
  });

  /**
   * The other half of a finished play: mirroring it into the local index.
   * Nothing re-reads a row because it was played, so what is not written here
   * is not shown at all.
   */
  describe('mirroring the play locally', () => {
    it('counts the play by one rather than setting a total', async () => {
      // The running total lives in the row; this caller never sees it.
      await scrobbleSong('t1', 1_700_000_000_000, 'a');

      expect(patchTrackMock).toHaveBeenCalledWith(
        'a',
        't1',
        expect.objectContaining({ playCountDelta: 1 }),
      );
    });

    it('records when it was played', async () => {
      await scrobbleSong('t1', 1_700_000_000_000, 'a');

      expect(patchTrackMock).toHaveBeenCalledWith(
        'a',
        't1',
        expect.objectContaining({ playedAt: 1_700_000_000_000 }),
      );
    });

    it('counts nothing when the server rejected the scrobble', async () => {
      // Counting a play the server rejected would drift the two apart with
      // nothing left to correct it.
      apiForServerMock.mockRejectedValue(new Error('server error'));

      await scrobbleSong('t1', 1_700_000_000_000, 'a');

      expect(patchTrackMock).not.toHaveBeenCalledWith(
        'a',
        't1',
        expect.objectContaining({ playCountDelta: expect.anything() }),
      );
    });

    it('still records the play locally when the server refused it', async () => {
      // A server that answers with an error is a different path from one the
      // guard never called — a 500, an expired credential, a timeout while the
      // browser still believes it is online. The play happened in all of them.
      apiForServerMock.mockRejectedValue(new Error('server error'));

      await scrobbleSong('t1', 1_700_000_000_000, 'a');

      expect(patchTrackMock).toHaveBeenCalledWith(
        'a',
        't1',
        { playedAt: 1_700_000_000_000 },
      );
    });

    it('counts nothing when the reachability guard skipped the call', async () => {
      // The guard is the ordinary offline path and far more common than a
      // rejection — and it returns without a word, so a caller that only awaits
      // the call cannot tell it apart from success.
      vi.mocked(shouldAttemptSubsonicForServer).mockImplementation(() => false);

      await scrobbleSong('t1', 1_700_000_000_000, 'a');

      expect(apiForServerMock).not.toHaveBeenCalled();
      expect(patchTrackMock).not.toHaveBeenCalledWith(
        'a',
        't1',
        expect.objectContaining({ playCountDelta: expect.anything() }),
      );
    });

    it('still records the play locally when the server was unreachable', async () => {
      // Listening offline happened, whatever the server knows. The timestamp is
      // ours to hold and a resync overwrites it; only the running tally has to
      // stay the server's.
      vi.mocked(shouldAttemptSubsonicForServer).mockImplementation(() => false);

      await scrobbleSong('t1', 1_700_000_000_000, 'a');

      expect(patchTrackMock).toHaveBeenCalledWith(
        'a',
        't1',
        { playedAt: 1_700_000_000_000 },
      );
    });
  });
});
