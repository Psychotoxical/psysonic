import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  audioInvalidatePreloads: vi.fn<() => Promise<void>>(),
  connectCacheListener: null as (() => void) | null,
}));

vi.mock('@/lib/api/audio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/audio')>()),
  audioInvalidatePreloads: mocks.audioInvalidatePreloads,
}));

vi.mock('@/lib/server/serverEndpoint', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/serverEndpoint')>()),
  subscribeConnectCache: (listener: () => void) => {
    mocks.connectCacheListener = listener;
    return () => {};
  },
}));

import '@/features/playback/store/playbackEngineBridgeRegister';
import {
  _resetGaplessPreloadStateForTest,
  getBytePreloadingId,
  getGaplessPreloadingId,
  setBytePreloadingRequest,
  setGaplessPreloadingId,
} from '@/features/playback/store/gaplessPreloadState';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useAuthStore } from '@/store/authStore';
import { resetAuthStore, resetPlayerStore } from '@/test/helpers/storeReset';

beforeEach(() => {
  resetAuthStore();
  resetPlayerStore();
  _resetGaplessPreloadStateForTest();
  mocks.audioInvalidatePreloads.mockReset();
  mocks.audioInvalidatePreloads.mockResolvedValue(undefined);
});

describe('playback preload invalidation', () => {
  it('does not invalidate when sanitized cap and format values are unchanged', async () => {
    useAuthStore.setState({
      streamQualityByAddress: { 'https://server.test': 128 },
      streamFormatByAddress: { 'https://server.test': 'opus' },
    });
    useAuthStore.getState().setStreamQualityForAddress('https://server.test', 128);
    useAuthStore.getState().setStreamFormatForAddress('https://server.test', 'opus');
    await Promise.resolve();
    expect(mocks.audioInvalidatePreloads).not.toHaveBeenCalled();
  });

  it('awaits native invalidation before clearing frontend preload ownership', async () => {
    let resolveNative: (() => void) | undefined;
    mocks.audioInvalidatePreloads.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveNative = resolve;
    }));
    setBytePreloadingRequest('["server","track"]', 'https://server.test/stream?id=track');
    setGaplessPreloadingId('["server","track"]');
    usePlayerStore.setState({ enginePreloadedTrackId: '["server","track"]' });

    useAuthStore.getState().setStreamQualityForAddress('https://server.test', 128);

    await vi.waitFor(() => expect(mocks.audioInvalidatePreloads).toHaveBeenCalledTimes(1));
    expect(getBytePreloadingId()).not.toBeNull();
    expect(getGaplessPreloadingId()).not.toBeNull();
    expect(usePlayerStore.getState().enginePreloadedTrackId).not.toBeNull();

    resolveNative?.();
    await vi.waitFor(() => {
      expect(getBytePreloadingId()).toBeNull();
      expect(getGaplessPreloadingId()).toBeNull();
      expect(usePlayerStore.getState().enginePreloadedTrackId).toBeNull();
    });
  });

  it('invalidates only for a real normalized server address-set change', async () => {
    const id = useAuthStore.getState().addServer({
      name: 'Server',
      url: 'https://server.test',
      username: 'u',
      password: 'p',
    });
    mocks.audioInvalidatePreloads.mockClear();

    useAuthStore.getState().updateServer(id, { url: 'https://server.test/' });
    await Promise.resolve();
    expect(mocks.audioInvalidatePreloads).not.toHaveBeenCalled();

    useAuthStore.getState().updateServer(id, { url: 'https://other.test' });
    await vi.waitFor(() => expect(mocks.audioInvalidatePreloads).toHaveBeenCalledTimes(1));
  });

  it('invalidates when the connect cache selects a different endpoint', async () => {
    expect(mocks.connectCacheListener).not.toBeNull();
    mocks.connectCacheListener?.();
    await vi.waitFor(() => expect(mocks.audioInvalidatePreloads).toHaveBeenCalledTimes(1));
  });

  it('serializes changes that arrive while native invalidation is in flight', async () => {
    let resolveFirst: (() => void) | undefined;
    mocks.audioInvalidatePreloads
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce(undefined);

    useAuthStore.getState().setStreamQualityForAddress('https://server.test', 128);
    useAuthStore.getState().setStreamFormatForAddress('https://server.test', 'opus');
    await vi.waitFor(() => expect(mocks.audioInvalidatePreloads).toHaveBeenCalledTimes(1));

    resolveFirst?.();
    await vi.waitFor(() => expect(mocks.audioInvalidatePreloads).toHaveBeenCalledTimes(2));
  });
});
