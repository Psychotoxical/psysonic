import { describe, it, expect, beforeEach } from 'vitest';
import { onInvoke, invokeMock } from '@/test/mocks/tauri';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { mirrorAlbumMetadataFromServerOnUse } from './patchOnUse';

describe('mirrorAlbumMetadataFromServerOnUse', () => {
  beforeEach(() => {
    useLibraryIndexStore.setState({ masterEnabled: true });
    onInvoke('library_patch_album', () => undefined);
  });

  it('mirrors server starred into the index', async () => {
    mirrorAlbumMetadataFromServerOnUse('s1', 'al1', {
      starred: '2024-01-01T00:00:00Z',
    });
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledWith('library_patch_album', {
      serverId: 's1',
      albumId: 'al1',
      patch: { starredAt: Date.parse('2024-01-01T00:00:00Z') },
    });
  });

  it('clears index starred when server payload is unstarred', async () => {
    mirrorAlbumMetadataFromServerOnUse('s1', 'al1', { starred: undefined });
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledWith('library_patch_album', {
      serverId: 's1',
      albumId: 'al1',
      patch: { starredAt: null },
    });
  });

  it('skips mirror when server omits starred key', async () => {
    mirrorAlbumMetadataFromServerOnUse('s1', 'al1', { id: 'al1' } as { starred?: string });
    await Promise.resolve();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
