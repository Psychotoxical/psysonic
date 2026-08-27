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

/** Answer `getSong.view` with these stats, everything else with an empty body. */
const serverReportsSong = (song: { playCount?: number; played?: string } | null) => {
  apiForServerMock.mockImplementation(async (_serverId, endpoint) =>
    endpoint === 'getSong.view' ? { song } : {},
  );
};

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

  it('reports, scrobbles and reads stats back through the guard without trackId', async () => {
    // All three are about a play, not about fetching bytes, so none of them may
    // be suppressed for a track the app happens to hold locally.
    vi.mocked(shouldAttemptSubsonicForServer).mockImplementation(
      (_serverId: string, trackId?: string) => trackId === undefined,
    );

    await reportNowPlaying('t-local', 'a');
    await scrobbleSong('t-local', 1_700_000_000_000, 'a');

    expect(shouldAttemptSubsonicForServer).toHaveBeenCalledWith('a');
    expect(shouldAttemptSubsonicForServer).not.toHaveBeenCalledWith('a', expect.anything());
    expect(apiForServerMock).toHaveBeenCalledTimes(3);
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
    expect(apiForServerMock).toHaveBeenNthCalledWith(3, 'a', 'getSong.view', { id: 't-local' });
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
    it('stores the count the server reports after taking the scrobble', async () => {
      // Deriving it locally cannot work: the row holds a server total, so a
      // local increment lands in a different unit and a sync arriving between
      // the two writes is indistinguishable from a lost or doubled play.
      serverReportsSong({ playCount: 7 });

      await scrobbleSong('t1', 1_700_000_000_000, 'a');

      expect(patchTrackMock).toHaveBeenCalledWith(
        'a',
        't1',
        expect.objectContaining({ playCount: 7 }),
      );
    });

    it('reads the count back even for a track playing from a local copy', async () => {
      // The reachability guard suppresses a call that names a track the app can
      // play locally. That is right for a byte fetch and wrong here — an offline
      // or hot-cached track still scrobbles, so its count still moves. Naming
      // the track in the guard call would lose exactly those tracks.
      serverReportsSong({ playCount: 7 });
      vi.mocked(shouldAttemptSubsonicForServer).mockImplementation(
        (_serverId, trackId) => trackId == null,
      );

      await scrobbleSong('t1', 1_700_000_000_000, 'a');

      expect(apiForServerMock).toHaveBeenCalledWith('a', 'getSong.view', { id: 't1' });
      expect(patchTrackMock).toHaveBeenCalledWith(
        'a',
        't1',
        expect.objectContaining({ playCount: 7 }),
      );
    });

    it("prefers the server's own play date over the local one", async () => {
      serverReportsSong({ playCount: 7, played: '2026-08-25T20:55:58.000Z' });

      await scrobbleSong('t1', 1_700_000_000_000, 'a');

      expect(patchTrackMock).toHaveBeenLastCalledWith(
        'a',
        't1',
        { playCount: 7, playedAt: Date.parse('2026-08-25T20:55:58.000Z') },
      );
    });

    it('keeps the local timestamp when the server reports no play date', async () => {
      // Clearing it would be worse than a slightly different clock: the play
      // demonstrably happened.
      serverReportsSong({ playCount: 7 });

      await scrobbleSong('t1', 1_700_000_000_000, 'a');

      expect(patchTrackMock).toHaveBeenLastCalledWith('a', 't1', { playCount: 7 });
    });

    it('records when it was played', async () => {
      await scrobbleSong('t1', 1_700_000_000_000, 'a');

      expect(patchTrackMock).toHaveBeenCalledWith(
        'a',
        't1',
        expect.objectContaining({ playedAt: 1_700_000_000_000 }),
      );
    });

    it('reads no count back when the server rejected the scrobble', async () => {
      // A rejected scrobble left the server tally untouched, so re-reading it
      // would only rewrite the value the row already holds.
      apiForServerMock.mockRejectedValue(new Error('server error'));

      await scrobbleSong('t1', 1_700_000_000_000, 'a');

      expect(apiForServerMock).not.toHaveBeenCalledWith('a', 'getSong.view', expect.anything());
      expect(patchTrackMock).not.toHaveBeenCalledWith(
        'a',
        't1',
        expect.objectContaining({ playCount: expect.anything() }),
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

    it('reads no count back when the reachability guard skipped the call', async () => {
      // The guard is the ordinary offline path and far more common than a
      // rejection — and it returns without a word, so a caller that only awaits
      // the call cannot tell it apart from success.
      vi.mocked(shouldAttemptSubsonicForServer).mockImplementation(() => false);

      await scrobbleSong('t1', 1_700_000_000_000, 'a');

      expect(apiForServerMock).not.toHaveBeenCalled();
      expect(patchTrackMock).not.toHaveBeenCalledWith(
        'a',
        't1',
        expect.objectContaining({ playCount: expect.anything() }),
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
