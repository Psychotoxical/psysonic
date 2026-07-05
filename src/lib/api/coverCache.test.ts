import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { makeTrack } from '@/test/helpers/factories';
import { resetAllStores } from '@/test/helpers/storeReset';
import { invokeMock, onInvoke } from '@/test/mocks/tauri';
import { coverArtRef } from '@/cover/ref';
import { coverCacheEnsure, coverCacheRestHost, librarySqlServerId } from './coverCache';
import { toQueueItemRefs } from '@/features/playback/store/queueItemRef';

describe('librarySqlServerId', () => {
  beforeEach(() => {
    resetAllStores();
    useAuthStore.setState({
      servers: [{ id: 'profile-uuid', name: 'Home', url: 'http://music.example:4533', username: 'u', password: 'p' }],
      activeServerId: 'profile-uuid',
    });
  });

  it('maps auth profile UUID to host index key for SQLite', () => {
    expect(librarySqlServerId('profile-uuid')).toBe('music.example:4533');
  });

  it('passes through values that are already index keys', () => {
    expect(librarySqlServerId('music.example:4533')).toBe('music.example:4533');
  });
});

describe('coverCacheRestHost', () => {
  it('strips /rest for Rust cover fetch', () => {
    expect(coverCacheRestHost('http://music.example:4533')).toBe('http://music.example:4533');
    expect(coverCacheRestHost('http://music.example:4533/')).toBe('http://music.example:4533');
  });
});

describe('coverCacheEnsure', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('uses playback server credentials when scope kind is playback', async () => {
    const activeServerId = useAuthStore.getState().addServer({
      name: 'Active',
      url: 'http://active.example:4533',
      username: 'active-user',
      password: 'active-pass',
    });
    const playbackServerId = useAuthStore.getState().addServer({
      name: 'Playback',
      url: 'http://playback.example:5533',
      username: 'playback-user',
      password: 'playback-pass',
    });
    useAuthStore.getState().setActiveServer(activeServerId);

    const track = makeTrack({ id: 'q1', coverArt: 'cover-1' });
    usePlayerStore.setState({
      queueItems: toQueueItemRefs(playbackServerId, [track]),
      queueIndex: 0,
      queueServerId: playbackServerId,
      currentTrack: track,
    });

    onInvoke('cover_cache_ensure', () => ({ hit: false, path: '', tier: 256 }));

    await coverCacheEnsure(coverArtRef('cover-1', { kind: 'playback' }), 256);

    const call = invokeMock.mock.calls.find(c => c[0] === 'cover_cache_ensure');
    expect(call).toBeTruthy();
    const payload = (call?.[1] as { args: Record<string, unknown> }).args;
    expect(payload.restBaseUrl).toBe('http://playback.example:5533');
    expect(payload.username).toBe('playback-user');
    expect(payload.password).toBe('playback-pass');
  });
});
