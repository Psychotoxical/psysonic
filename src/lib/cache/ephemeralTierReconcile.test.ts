import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reconcileEphemeralCache } from '@/lib/cache/ephemeralTierReconcile';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';

describe('reconcileEphemeralCache', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    useLocalPlaybackStore.setState({ entries: {} });
  });

  it('drops stale index rows and prunes empty dirs without deleting unindexed files', async () => {
    useLocalPlaybackStore.setState({
      entries: {
        'srv:gone': {
          serverIndexKey: 'srv',
          trackId: 'gone',
          localPath: '/media/cache/srv/gone.flac',
          layoutFingerprint: '',
          sizeBytes: 1,
          tier: 'ephemeral',
          cachedAt: 1,
          suffix: 'flac',
        },
        'srv:keep': {
          serverIndexKey: 'srv',
          trackId: 'keep',
          localPath: '/media/cache/srv/keep.flac',
          layoutFingerprint: '',
          sizeBytes: 2,
          tier: 'ephemeral',
          cachedAt: 2,
          suffix: 'flac',
        },
      },
    });

    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd === 'probe_media_files') {
        const paths = (args as { localPaths: string[] }).localPaths;
        return paths.map(p => p.endsWith('keep.flac'));
      }
      if (cmd === 'prune_empty_media_tier_dirs') return undefined;
      throw new Error(`unexpected invoke ${cmd}`);
    });

    const result = await reconcileEphemeralCache({
      entries: useLocalPlaybackStore.getState().entries,
      removeEntry: useLocalPlaybackStore.getState().removeEntry,
    });

    expect(result).toEqual({ removedStaleIndex: 1 });
    expect(useLocalPlaybackStore.getState().entries['srv:keep']).toBeDefined();
    expect(useLocalPlaybackStore.getState().entries['srv:gone']).toBeUndefined();
    expect(invoke).not.toHaveBeenCalledWith(
      'prune_orphan_ephemeral_cache_files',
      expect.anything(),
    );
    expect(invoke).toHaveBeenCalledWith('prune_empty_media_tier_dirs', {
      tier: 'ephemeral',
      mediaDir: null,
    });
  });
});
