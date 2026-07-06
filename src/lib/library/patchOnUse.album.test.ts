import { describe, it, expect, beforeEach } from 'vitest';
import { onInvoke, invokeMock } from '@/test/mocks/tauri';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { patchLibraryAlbumOnUse } from './patchOnUse';

describe('patchLibraryAlbumOnUse', () => {
  beforeEach(() => {
    useLibraryIndexStore.setState({ masterEnabled: true });
    onInvoke('library_patch_album', () => undefined);
  });

  it('patches album starred_at when the index is enabled', async () => {
    patchLibraryAlbumOnUse('s1', 'al1', { starredAt: 1700 });
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledWith('library_patch_album', {
      serverId: 's1',
      albumId: 'al1',
      patch: { starredAt: 1700 },
    });
  });

  it('forwards explicit null to clear album starred_at', async () => {
    patchLibraryAlbumOnUse('s1', 'al1', { starredAt: null });
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledWith('library_patch_album', {
      serverId: 's1',
      albumId: 'al1',
      patch: { starredAt: null },
    });
  });

  it('is a no-op when the index is disabled', async () => {
    useLibraryIndexStore.setState({ masterEnabled: false });
    patchLibraryAlbumOnUse('s1', 'al1', { starredAt: 1700 });
    await Promise.resolve();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
