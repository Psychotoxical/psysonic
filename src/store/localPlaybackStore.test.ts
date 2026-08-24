import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { localPlaybackEntryKey } from '@/store/localPlaybackKeys';
import { useLocalPlaybackStore, type LocalPlaybackEntry } from '@/store/localPlaybackStore';
import { makeServer } from '@/test/helpers/factories';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { invokeMock, onInvoke } from '@/test/mocks/tauri';

function ephemeralEntry(
  serverIndexKey: string,
  trackId: string,
  localPath: string,
): LocalPlaybackEntry {
  return {
    serverIndexKey,
    trackId,
    localPath,
    layoutFingerprint: 'fp',
    sizeBytes: 80,
    tier: 'ephemeral',
    cachedAt: 1,
    suffix: 'mp3',
  };
}

describe('local playback eviction server scope', () => {
  beforeEach(() => {
    resetAuthStore();
    useLocalPlaybackStore.setState({ entries: {} });
    useAuthStore.setState({
      servers: [
        makeServer({ id: 'a', url: 'http://a.test' }),
        makeServer({ id: 'b', url: 'http://b.test' }),
      ],
      activeServerId: 'a',
    });

    onInvoke('probe_media_files', args => {
      const paths = (args as { localPaths: string[] }).localPaths;
      return paths.map(() => true);
    });
    onInvoke('prune_empty_media_tier_dirs', () => ({ status: 'ok', data: null }));
    onInvoke('delete_media_file', () => ({ status: 'ok', data: null }));
  });

  it('keeps a protected foreign-server track when the active server reuses its id', async () => {
    const activeKey = localPlaybackEntryKey('a.test', 'shared');
    const protectedKey = localPlaybackEntryKey('b.test', 'shared');
    useLocalPlaybackStore.setState({
      entries: {
        [activeKey]: ephemeralEntry('a.test', 'shared', '/cache/a/shared.mp3'),
        [protectedKey]: ephemeralEntry('b.test', 'shared', '/cache/b/shared.mp3'),
      },
    });

    let sizeRead = 0;
    onInvoke('get_media_tier_size', () => {
      sizeRead += 1;
      return sizeRead === 1 ? 160 : 80;
    });

    await useLocalPlaybackStore.getState().evictEphemeralToFit(
      [
        { serverId: 'a', trackId: 'current' },
        { serverId: 'b', trackId: 'shared' },
      ],
      0,
      80,
      'a.test',
      null,
    );

    expect(invokeMock).toHaveBeenCalledWith('delete_media_file', {
      localPath: '/cache/a/shared.mp3',
      mediaDir: null,
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      'delete_media_file',
      expect.objectContaining({ localPath: '/cache/b/shared.mp3' }),
    );
    expect(useLocalPlaybackStore.getState().entries[activeKey]).toBeUndefined();
    expect(useLocalPlaybackStore.getState().entries[protectedKey]).toBeDefined();
  });

  it('keeps shared bytes until the last pin source is removed', async () => {
    const base = {
      serverIndexKey: 'a.test',
      trackId: 'shared',
      localPath: '/media/library/a.test/shared.flac',
      layoutFingerprint: 'fp',
      sizeBytes: 80,
      tier: 'library' as const,
      suffix: 'flac',
    };
    useLocalPlaybackStore.getState().upsertEntry({
      ...base,
      pinSource: { kind: 'album', sourceId: 'album-a' },
    });
    useLocalPlaybackStore.getState().upsertEntry({
      ...base,
      pinSource: { kind: 'playlist', sourceId: 'playlist-b' },
    });

    expect(useLocalPlaybackStore.getState().listPinnedGroups()).toEqual([
      expect.objectContaining({ pinSource: { kind: 'album', sourceId: 'album-a' } }),
      expect.objectContaining({ pinSource: { kind: 'playlist', sourceId: 'playlist-b' } }),
    ]);

    await useLocalPlaybackStore.getState().removePinSource(
      'shared',
      'a.test',
      { kind: 'playlist', sourceId: 'playlist-b' },
      null,
    );
    expect(invokeMock).not.toHaveBeenCalledWith(
      'delete_media_file',
      expect.objectContaining({ localPath: base.localPath }),
    );
    expect(useLocalPlaybackStore.getState().getEntry('shared', 'a.test')?.pinSource)
      .toEqual({ kind: 'album', sourceId: 'album-a' });

    await useLocalPlaybackStore.getState().removePinSource(
      'shared',
      'a.test',
      { kind: 'album', sourceId: 'album-a' },
      null,
    );
    expect(invokeMock).toHaveBeenCalledWith('delete_media_file', {
      localPath: base.localPath,
      mediaDir: null,
    });
    expect(useLocalPlaybackStore.getState().getEntry('shared', 'a.test')).toBeNull();
  });
});
