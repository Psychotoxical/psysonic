import { beforeEach, describe, expect, it } from 'vitest';
import { rewriteFrontendStoreKeysForRemap } from '@/utils/server/rewriteFrontendStoreKeys';
import { useOfflineStore, type OfflineAlbumMeta } from '@/features/offline/store/offlineStore';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { resetAllStores } from '@/test/helpers/storeReset';

// Scenario: URL-change remigration × front-end store-key rewrite. After a server URL
// edit re-tags the SQLite/disk keys, the in-memory zustand stores must repoint their
// old index key to the new one — offline album keys, local-playback entries, and the
// player queue's serverId (+ per-item refs). Unrelated keys must be left untouched.

const album = (id: string, serverId: string): OfflineAlbumMeta => ({
  id,
  serverId,
  name: id,
  artist: 'A',
  trackIds: [],
});

beforeEach(() => {
  resetAllStores();
  useOfflineStore.setState({ albums: {} });
  useLocalPlaybackStore.setState({ entries: {} });
});

function seedEntry(serverIndexKey: string, trackId: string): void {
  useLocalPlaybackStore.getState().upsertEntry({
    serverIndexKey,
    trackId,
    localPath: `/disk/${trackId}.opus`,
    layoutFingerprint: 'fp',
    sizeBytes: 1,
    suffix: 'opus',
    tier: 'library',
  });
}

describe('URL remigration × store-key rewrite', () => {
  it('repoints old→new across offline albums, local playback, and the player queue; leaves others', async () => {
    useOfflineStore.setState({
      albums: { 'old:alb1': album('alb1', 'old'), 'keep:alb2': album('alb2', 'keep') },
    });
    seedEntry('old', 't1');
    seedEntry('keep', 't2');
    usePlayerStore.setState({
      queueServerId: 'old',
      queueItems: [
        { serverId: 'old', trackId: 't1' },
        { serverId: 'keep', trackId: 't2' },
      ],
    });

    await rewriteFrontendStoreKeysForRemap([{ oldKey: 'old', newKey: 'new' }]);

    // Offline albums: old key repointed (serverId updated), unrelated key untouched.
    const albums = useOfflineStore.getState().albums;
    expect(albums['new:alb1']?.serverId).toBe('new');
    expect(albums['old:alb1']).toBeUndefined();
    expect(albums['keep:alb2']?.serverId).toBe('keep');

    // Local playback: entry repointed to the new index key, unrelated entry untouched.
    const lp = useLocalPlaybackStore.getState();
    expect(lp.getEntry('t1', 'new')?.serverIndexKey).toBe('new');
    expect(lp.getEntry('t1', 'old')).toBeNull();
    expect(lp.getEntry('t2', 'keep')?.serverIndexKey).toBe('keep');

    // Player queue: bound server + per-item ref repointed; the unrelated ref stays.
    const player = usePlayerStore.getState();
    expect(player.queueServerId).toBe('new');
    expect(player.queueItems.find(r => r.trackId === 't1')?.serverId).toBe('new');
    expect(player.queueItems.find(r => r.trackId === 't2')?.serverId).toBe('keep');
  });

  it('is a no-op when old and new keys are equal', async () => {
    useOfflineStore.setState({ albums: { 'same:alb1': album('alb1', 'same') } });
    await rewriteFrontendStoreKeysForRemap([{ oldKey: 'same', newKey: 'same' }]);
    expect(useOfflineStore.getState().albums['same:alb1']?.serverId).toBe('same');
  });
});
