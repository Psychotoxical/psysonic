import { describe, it, expect, beforeEach } from 'vitest';
import { onInvoke, invokeMock } from '@/test/mocks/tauri';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { patchLibraryTrackOnUse } from './patchOnUse';

describe('patchLibraryTrackOnUse', () => {
  beforeEach(() => {
    useLibraryIndexStore.setState({ masterEnabled: true });
    onInvoke('library_patch_track', () => undefined);
  });

  it('patches the library track when the index is enabled', async () => {
    patchLibraryTrackOnUse('s1', 't1', { starredAt: 1700 });
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledWith('library_patch_track', {
      serverId: 's1',
      trackId: 't1',
      patch: { starredAt: 1700 },
    });
  });

  it('forwards an explicit null (unstar) so the column can be cleared', async () => {
    patchLibraryTrackOnUse('s1', 't1', { starredAt: null });
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledWith('library_patch_track', {
      serverId: 's1',
      trackId: 't1',
      patch: { starredAt: null },
    });
  });

  it('is a no-op when the index is disabled for the server', async () => {
    useLibraryIndexStore.setState({ masterEnabled: false });
    patchLibraryTrackOnUse('s1', 't1', { userRating: 4 });
    await Promise.resolve();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('is a no-op without a server id', async () => {
    patchLibraryTrackOnUse(null, 't1', { userRating: 4 });
    await Promise.resolve();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('never throws when the patch invoke rejects', async () => {
    onInvoke('library_patch_track', () => {
      throw new Error('boom');
    });
    expect(() => patchLibraryTrackOnUse('s1', 't1', { playedAt: 9 })).not.toThrow();
    await Promise.resolve();
  });
});
