import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '../store/playerStore';
import { scrobbleSong } from './subsonicScrobble';

const { apiForServerMock } = vi.hoisted(() => ({
  apiForServerMock: vi.fn(async () => ({})),
}));

vi.mock('./subsonicClient', () => ({
  api: vi.fn(),
  apiForServer: apiForServerMock,
}));

describe('subsonicScrobble', () => {
  beforeEach(() => {
    apiForServerMock.mockClear();
    useAuthStore.setState({
      servers: [
        { id: 'a', name: 'A', url: 'http://a.test', username: 'u', password: 'p' },
        { id: 'b', name: 'B', url: 'http://b.test', username: 'u', password: 'p' },
      ],
      activeServerId: 'b',
      isLoggedIn: true,
    });
    usePlayerStore.setState({
      queue: [{ id: 't1', title: 'T', artist: 'A', album: 'Al', albumId: 'al1', duration: 100 }],
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
});
