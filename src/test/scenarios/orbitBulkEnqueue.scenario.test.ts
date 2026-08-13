import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { registerOrbitRuntime } from '@/store/orbitRuntime';
import { makeTracks } from '@/test/helpers/factories';
import { resetAllStores } from '@/test/helpers/storeReset';
import { onInvoke } from '@/test/mocks/tauri';

// Scenario: orbit session × bulk enqueue. The real `enqueue` action routes a
// multi-track enqueue through the orbitRuntime.bulkGuard seam and only commits the
// tracks when the guard resolves true; a single track bypasses the guard entirely.
// We inject a fake runtime and assert the observable queue outcome.

const flush = () => new Promise((r) => setTimeout(r, 0));

let bulkGuard: Mock<(count: number) => Promise<boolean>>;
let allowsTrackServer: Mock<(serverId?: string) => boolean>;

beforeEach(() => {
  resetAllStores();
  onInvoke('audio_play', () => undefined);
  bulkGuard = vi.fn<(count: number) => Promise<boolean>>(async () => true);
  allowsTrackServer = vi.fn<(serverId?: string) => boolean>(() => true);
  registerOrbitRuntime({
    getSnapshot: () => ({ role: 'host', phase: 'active', state: null, serverId: 'srv-owner' }),
    bulkGuard,
    allowsTrackServer,
  });
});

describe('orbit session × bulk enqueue', () => {
  it('over-threshold + guard accepts → tracks enqueued', async () => {
    bulkGuard.mockResolvedValue(true);
    usePlayerStore.getState().enqueue(makeTracks(2));
    await flush();
    expect(bulkGuard).toHaveBeenCalledWith(2);
    expect(usePlayerStore.getState().queueItems).toHaveLength(2);
  });

  it('over-threshold + guard rejects → nothing enqueued', async () => {
    bulkGuard.mockResolvedValue(false);
    usePlayerStore.getState().enqueue(makeTracks(2));
    await flush();
    expect(bulkGuard).toHaveBeenCalledWith(2);
    expect(usePlayerStore.getState().queueItems).toHaveLength(0);
  });

  it('host queue mutations discard tracks owned by another server', async () => {
    allowsTrackServer.mockImplementation(serverId => serverId === 'srv-owner');
    const [owner, foreign] = makeTracks(2);
    owner.serverId = 'srv-owner';
    foreign.serverId = 'srv-foreign';

    usePlayerStore.getState().enqueue([owner, foreign]);
    await flush();

    expect(usePlayerStore.getState().queueItems).toEqual([
      expect.objectContaining({ trackId: owner.id, serverId: 'srv-owner' }),
    ]);
  });

  it('host play ignores a foreign-server replacement', () => {
    allowsTrackServer.mockImplementation(serverId => serverId === 'srv-owner');
    const [foreign] = makeTracks(1);
    foreign.serverId = 'srv-foreign';

    usePlayerStore.getState().playTrack(foreign, [foreign]);

    expect(usePlayerStore.getState().currentTrack).toBeNull();
    expect(usePlayerStore.getState().queueItems).toEqual([]);
  });

  it('host Play Next ignores a foreign owner without rebinding the queue', () => {
    allowsTrackServer.mockImplementation(serverId => serverId === 'srv-owner');
    const [foreign] = makeTracks(1);
    foreign.serverId = 'srv-foreign';

    usePlayerStore.getState().playNext([foreign]);

    expect(usePlayerStore.getState().queueServerId).toBeNull();
    expect(usePlayerStore.getState().queueItems).toEqual([]);
  });

  it('single track bypasses the guard and enqueues directly', async () => {
    usePlayerStore.getState().enqueue(makeTracks(1));
    await flush();
    expect(bulkGuard).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().queueItems).toHaveLength(1);
  });
});
