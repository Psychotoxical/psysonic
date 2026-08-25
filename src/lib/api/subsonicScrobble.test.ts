import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What a finished play leaves behind locally.
 *
 * The server gets the scrobble either way; the point of these is the second
 * half — mirroring the play into the local index. Nothing else re-reads the row
 * afterwards, so whatever is not written here is not shown at all.
 */

const hoisted = vi.hoisted(() => ({
  apiForServer: vi.fn(async () => undefined),
  patchTrack: vi.fn(),
  reachable: true,
}));

vi.mock('@/lib/api/subsonicClient', () => ({
  api: vi.fn(),
  apiForServer: hoisted.apiForServer,
}));
vi.mock('@/lib/library/patchOnUse', () => ({
  patchLibraryTrackOnUse: hoisted.patchTrack,
}));
vi.mock('@/lib/network/subsonicNetworkGuard', () => ({
  shouldAttemptSubsonicForServer: () => hoisted.reachable,
}));

import { scrobbleSong } from './subsonicScrobble';

beforeEach(() => {
  hoisted.apiForServer.mockClear();
  hoisted.apiForServer.mockResolvedValue(undefined);
  hoisted.patchTrack.mockClear();
  hoisted.reachable = true;
});

describe('scrobbleSong', () => {
  it('tells the server the track was played', async () => {
    await scrobbleSong('tr_1', 1_700, 's1');

    expect(hoisted.apiForServer).toHaveBeenCalledWith(
      's1',
      'scrobble.view',
      expect.objectContaining({ id: 'tr_1', submission: true, time: 1_700 }),
    );
  });

  it('counts the play in the local index', async () => {
    // By one, not to a total: the running count lives in the row, and this
    // caller never sees it.
    await scrobbleSong('tr_1', 1_700, 's1');

    expect(hoisted.patchTrack).toHaveBeenCalledWith(
      's1',
      'tr_1',
      expect.objectContaining({ playCountDelta: 1 }),
    );
  });

  it('records when it was played', async () => {
    await scrobbleSong('tr_1', 1_700, 's1');

    expect(hoisted.patchTrack).toHaveBeenCalledWith(
      's1',
      'tr_1',
      expect.objectContaining({ playedAt: 1_700 }),
    );
  });

  it('counts nothing when the server did not take the scrobble', async () => {
    // Adding to the local count for a play the server rejected would drift the
    // two apart with nothing to correct it.
    hoisted.apiForServer.mockRejectedValue(new Error('offline'));

    await scrobbleSong('tr_1', 1_700, 's1');

    expect(hoisted.patchTrack).not.toHaveBeenCalled();
  });

  it('does nothing at all without a server', async () => {
    await scrobbleSong('tr_1', 1_700, '');

    expect(hoisted.apiForServer).not.toHaveBeenCalled();
    expect(hoisted.patchTrack).not.toHaveBeenCalled();
  });
});
