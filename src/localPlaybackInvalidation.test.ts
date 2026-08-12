import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emitTauriEvent, tauriMockListenerCount } from '@/test/mocks/tauri';
import { useAuthStore } from '@/store/authStore';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';

const libraryGetTrackMock = vi.fn();
const deleteMediaFileMock = vi.fn(async (_args: { localPath: string; mediaDir: string | null }) => undefined);

vi.mock('@/lib/api/library', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/api/library')>()),
  libraryGetTrack: (serverId: string, trackId: string) => libraryGetTrackMock(serverId, trackId),
}));

vi.mock('@/lib/api/syncfs', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/api/syncfs')>()),
  deleteMediaFile: (args: { localPath: string; mediaDir: string | null }) => deleteMediaFileMock(args),
}));

vi.mock('@/features/offline/utils/legacyOfflineFileMigration', () => ({
  runLegacyOfflineFileMigration: vi.fn(async () => undefined),
}));

vi.mock('@/features/offline/utils/libraryTierReconcile', () => ({
  reconcileLibraryTierForServer: vi.fn(async () => undefined),
}));

import {
  initLocalPlaybackInvalidation,
  pauseAndDrainLocalPlaybackInvalidation,
  resumeLocalPlaybackInvalidation,
} from './localPlaybackInvalidation';

describe('local playback invalidation', () => {
  beforeEach(() => {
    libraryGetTrackMock.mockReset();
    deleteMediaFileMock.mockClear();
    useAuthStore.setState({
      servers: [{ id: 'srv', name: 'Server', url: 'https://music.test', username: 'u', password: 'p' }],
    });
    useLocalPlaybackStore.setState({
      entries: {
        'music.test:legacy-track': {
          serverIndexKey: 'music.test',
          trackId: 'legacy-track',
          localPath: '/media/legacy.flac',
          layoutFingerprint: 'old',
          sizeBytes: 1,
          tier: 'library',
          cachedAt: 1,
          suffix: 'flac',
        },
      },
    });
  });

  it('ignores failed sync-idle events used to start identity migration', async () => {
    const cleanup = initLocalPlaybackInvalidation();
    await vi.waitFor(() => expect(tauriMockListenerCount('library:sync-idle')).toBe(1));

    emitTauriEvent('library:sync-idle', {
      serverId: 'music.test', libraryScope: 'all', kind: 'delta_sync', ok: false,
      error: 'identity transition: migration required',
    });
    await Promise.resolve();

    expect(libraryGetTrackMock).not.toHaveBeenCalled();
    cleanup();
  });

  it('does not remove an entry when migration pauses a stale lookup', async () => {
    let resolveTrack!: (value: null) => void;
    libraryGetTrackMock.mockImplementation(() => new Promise(resolve => { resolveTrack = resolve; }));
    const cleanup = initLocalPlaybackInvalidation();
    await vi.waitFor(() => expect(tauriMockListenerCount('library:sync-idle')).toBe(1));
    emitTauriEvent('library:sync-idle', {
      serverId: 'music.test', libraryScope: 'all', kind: 'delta_sync', ok: true,
    });
    await vi.waitFor(() => expect(libraryGetTrackMock).toHaveBeenCalled());

    const paused = pauseAndDrainLocalPlaybackInvalidation();
    resolveTrack(null);
    await paused;

    expect(deleteMediaFileMock).not.toHaveBeenCalled();
    expect(useLocalPlaybackStore.getState().entries['music.test:legacy-track']).toBeDefined();
    resumeLocalPlaybackInvalidation();
    cleanup();
  });

  it('removes the index row when migration pauses an in-flight delete', async () => {
    let resolveDelete!: () => void;
    libraryGetTrackMock.mockResolvedValue(null);
    deleteMediaFileMock.mockImplementationOnce(() => new Promise<undefined>(resolve => {
      resolveDelete = () => resolve(undefined);
    }));
    const cleanup = initLocalPlaybackInvalidation();
    await vi.waitFor(() => expect(tauriMockListenerCount('library:sync-idle')).toBe(1));
    emitTauriEvent('library:sync-idle', {
      serverId: 'music.test', libraryScope: 'all', kind: 'delta_sync', ok: true,
    });
    await vi.waitFor(() => expect(deleteMediaFileMock).toHaveBeenCalled());

    const paused = pauseAndDrainLocalPlaybackInvalidation();
    resolveDelete();
    await paused;

    expect(useLocalPlaybackStore.getState().entries['music.test:legacy-track']).toBeUndefined();
    resumeLocalPlaybackInvalidation();
    cleanup();
  });
});
