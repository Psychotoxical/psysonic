import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveSources: vi.fn(),
  getTrack: vi.fn(),
  hasLocalPlaybackUrl: vi.fn(),
}));

vi.mock('@/lib/api/library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/library')>()),
  libraryResolveEntitySources: mocks.resolveSources,
  libraryGetTrack: mocks.getTrack,
}));

vi.mock('@/store/localPlaybackResolve', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/store/localPlaybackResolve')>()),
  hasLocalPlaybackUrl: mocks.hasLocalPlaybackUrl,
}));

import {
  _resetPlaybackAlternativeStoreForTest,
  beginPlaybackAlternativeResolution,
  usePlaybackAlternativeStore,
} from '@/features/playback/store/playbackAlternativeStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { makeServer, makeTrack, seedQueue } from '@/test/helpers/factories';
import { resetAuthStore, resetPlayerStore } from '@/test/helpers/storeReset';
import { serverIndexKeyForProfile } from '@/lib/server/serverIndexKey';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('explicit playback alternatives', () => {
  beforeEach(() => {
    resetPlayerStore();
    resetAuthStore();
    _resetPlaybackAlternativeStoreForTest();
    mocks.resolveSources.mockReset();
    mocks.getTrack.mockReset();
    mocks.hasLocalPlaybackUrl.mockReset().mockReturnValue(false);

    const primary = makeServer({ id: 'primary', name: 'Primary', url: 'https://primary.test' });
    const backup = makeServer({ id: 'backup', name: 'Backup', url: 'https://backup.test' });
    useAuthStore.setState({
      servers: [primary, backup],
      activeServerId: primary.id,
      musicLibraryServerIds: [primary.id, backup.id],
      musicLibrarySelectionByServer: { primary: [], backup: [] },
      musicLibraryFilterByServer: { primary: 'all', backup: 'all' },
    });
    useLibraryIndexStore.setState({
      connectionByServer: {
        [serverIndexKeyForProfile(primary)]: 'online',
        [serverIndexKeyForProfile(backup)]: 'online',
      },
    });
  });

  it('does not auto-fallback or mutate the queue while alternatives are offered', async () => {
    const failed = makeTrack({ id: 'failed', serverId: 'primary' });
    seedQueue([failed], { serverId: 'primary' });
    const playTrack = vi.fn();
    usePlayerStore.setState({ playTrack });
    mocks.resolveSources.mockResolvedValue([
      { serverId: 'primary', id: 'failed', libraryId: '', priority: 0, durationSec: 180, suffix: 'flac', bitRate: 320, sizeBytes: 1, starredAt: null, userRating: null },
      { serverId: 'backup', id: 'backup-track', libraryId: '', priority: 1, durationSec: 180, suffix: 'flac', bitRate: 320, sizeBytes: 1, starredAt: null, userRating: null },
    ]);

    expect(beginPlaybackAlternativeResolution('network failed')).toBe(true);
    await flush();

    expect(usePlayerStore.getState().queueItems).toEqual([
      expect.objectContaining({ trackId: 'failed' }),
    ]);
    expect(playTrack).not.toHaveBeenCalled();
    expect(usePlaybackAlternativeStore.getState().status).toBe('ready');
  });

  it('replaces only the failed queue slot and retries that concrete source', async () => {
    const queue = [
      makeTrack({ id: 'before', serverId: 'primary' }),
      makeTrack({ id: 'failed', serverId: 'primary' }),
      makeTrack({ id: 'after', serverId: 'primary' }),
    ];
    seedQueue(queue, { index: 1, serverId: 'primary' });
    const playTrack = vi.fn();
    usePlayerStore.setState({ playTrack });
    mocks.resolveSources.mockResolvedValue([
      { serverId: 'backup', id: 'replacement', libraryId: '', priority: 1, durationSec: 201, suffix: 'flac', bitRate: 900, sizeBytes: 42, starredAt: null, userRating: null },
    ]);
    mocks.getTrack.mockResolvedValue({
      serverId: 'backup', id: 'replacement', title: 'Replacement', artist: 'Artist', album: 'Album',
      albumId: 'album-backup', durationSec: 201, coverArtId: 'cover-backup', replayGainTrackDb: -7,
      replayGainAlbumDb: -5, replayGainPeak: 0.9, syncedAt: 1, rawJson: {},
    });

    beginPlaybackAlternativeResolution('network failed');
    await flush();
    const alternative = usePlaybackAlternativeStore.getState().alternatives[0]!;
    await usePlaybackAlternativeStore.getState().choose(alternative);

    const items = usePlayerStore.getState().queueItems;
    expect(items.map(item => item.trackId)).toEqual(['before', 'replacement', 'after']);
    expect(items[1]?.serverId).toBe(serverIndexKeyForProfile(useAuthStore.getState().servers[1]!));
    expect(playTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'replacement',
        serverId: 'backup',
        coverArt: 'cover-backup',
        replayGainTrackDb: -7,
      }),
      undefined,
      false,
      false,
      1,
    );
  });

  it('surfaces an empty state when no alternative source is reachable or local', async () => {
    const failed = makeTrack({ id: 'failed', serverId: 'primary' });
    seedQueue([failed], { serverId: 'primary' });
    mocks.resolveSources.mockResolvedValue([
      { serverId: 'primary', id: 'failed', libraryId: '', priority: 0, durationSec: 180, suffix: null, bitRate: null, sizeBytes: null, starredAt: null, userRating: null },
    ]);

    const resumeNormalSkip = vi.fn();
    beginPlaybackAlternativeResolution('network failed', resumeNormalSkip);
    await flush();

    expect(usePlaybackAlternativeStore.getState()).toMatchObject({
      isOpen: true,
      status: 'empty',
      alternatives: [],
    });
    expect(resumeNormalSkip).toHaveBeenCalledTimes(1);
  });

  it('restores normal skip when alternative resolution fails', async () => {
    const failed = makeTrack({ id: 'failed', serverId: 'primary' });
    seedQueue([failed], { serverId: 'primary' });
    const resumeNormalSkip = vi.fn();
    mocks.resolveSources.mockRejectedValue(new Error('index unavailable'));

    beginPlaybackAlternativeResolution('network failed', resumeNormalSkip);
    await flush();

    expect(usePlaybackAlternativeStore.getState().status).toBe('error');
    expect(resumeNormalSkip).toHaveBeenCalledTimes(1);
  });

  it('restores normal skip when the user closes without choosing an alternative', async () => {
    const failed = makeTrack({ id: 'failed', serverId: 'primary' });
    seedQueue([failed], { serverId: 'primary' });
    const resumeNormalSkip = vi.fn();
    mocks.resolveSources.mockResolvedValue([
      { serverId: 'backup', id: 'replacement', libraryId: '', priority: 1, durationSec: 180, suffix: 'flac', bitRate: 320, sizeBytes: 1, starredAt: null, userRating: null },
    ]);

    beginPlaybackAlternativeResolution('network failed', resumeNormalSkip);
    await flush();
    usePlaybackAlternativeStore.getState().close();

    expect(resumeNormalSkip).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().queueItems[0]?.trackId).toBe('failed');
  });

  it('does not restore normal skip after the user explicitly chooses a source', async () => {
    const failed = makeTrack({ id: 'failed', serverId: 'primary' });
    seedQueue([failed], { serverId: 'primary' });
    const playTrack = vi.fn();
    const resumeNormalSkip = vi.fn();
    usePlayerStore.setState({ playTrack });
    mocks.resolveSources.mockResolvedValue([
      { serverId: 'backup', id: 'replacement', libraryId: '', priority: 1, durationSec: 180, suffix: 'flac', bitRate: 320, sizeBytes: 1, starredAt: null, userRating: null },
    ]);
    mocks.getTrack.mockResolvedValue({
      serverId: 'backup', id: 'replacement', title: 'Replacement', artist: 'Artist', album: 'Album',
      albumId: 'album-backup', durationSec: 180, coverArtId: null, syncedAt: 1, rawJson: {},
    });

    beginPlaybackAlternativeResolution('network failed', resumeNormalSkip);
    await flush();
    await usePlaybackAlternativeStore.getState().choose(usePlaybackAlternativeStore.getState().alternatives[0]!);

    expect(playTrack).toHaveBeenCalledTimes(1);
    expect(resumeNormalSkip).not.toHaveBeenCalled();
  });

  it('offers a downloaded alternative even when its server is offline', async () => {
    const failed = makeTrack({ id: 'failed', serverId: 'primary' });
    seedQueue([failed], { serverId: 'primary' });
    const backup = useAuthStore.getState().servers[1]!;
    useLibraryIndexStore.setState({
      connectionByServer: { [serverIndexKeyForProfile(backup)]: 'offline' },
    });
    mocks.hasLocalPlaybackUrl.mockImplementation((trackId: string, serverId: string) =>
      trackId === 'downloaded' && serverId === 'backup');
    mocks.resolveSources.mockResolvedValue([
      { serverId: 'backup', id: 'downloaded', libraryId: '', priority: 1, durationSec: 180, suffix: 'flac', bitRate: 320, sizeBytes: 10, starredAt: null, userRating: null },
    ]);

    beginPlaybackAlternativeResolution('network failed');
    await flush();

    expect(usePlaybackAlternativeStore.getState().alternatives).toEqual([
      expect.objectContaining({ serverName: 'Backup', local: true }),
    ]);
  });
});
