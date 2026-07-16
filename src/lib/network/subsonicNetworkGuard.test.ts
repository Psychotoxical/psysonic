import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { setActiveServerReachable } from '@/lib/network/activeServerReachability';
import {
  isSubsonicServerReachableForUnifiedScope,
  shouldAttemptSubsonicForServer,
} from '@/lib/network/subsonicNetworkGuard';
import { replaceLibraryServerConnectionSnapshot } from '@/lib/network/libraryServerReachability';

const hasLocalPlaybackUrlMock = vi.fn((_trackId: string, _serverId: string) => false);

vi.mock('@/store/localPlaybackResolve', () => ({
  hasLocalPlaybackUrl: (trackId: string, serverId: string) =>
    hasLocalPlaybackUrlMock(trackId, serverId),
}));

describe('shouldAttemptSubsonicForServer', () => {
  beforeEach(() => {
    resetAuthStore();
    setActiveServerReachable(null);
    hasLocalPlaybackUrlMock.mockReturnValue(false);
    replaceLibraryServerConnectionSnapshot({});
  });

  it('returns false without a server id', () => {
    expect(shouldAttemptSubsonicForServer('')).toBe(false);
  });

  it('returns false when the active server probe failed', () => {
    const activeId = useAuthStore.getState().addServer({
      name: 'Active',
      url: 'http://active.test',
      username: 'u',
      password: 'p',
    });
    useAuthStore.getState().setActiveServer(activeId);
    setActiveServerReachable(false);
    expect(shouldAttemptSubsonicForServer(activeId, 't1')).toBe(false);
  });

  it('allows a non-active playback server when the active probe failed', () => {
    const playbackId = useAuthStore.getState().addServer({
      name: 'Playback',
      url: 'http://playback.test',
      username: 'u',
      password: 'p',
    });
    const activeId = useAuthStore.getState().addServer({
      name: 'Browse',
      url: 'http://browse.test',
      username: 'u',
      password: 'p',
    });
    useAuthStore.getState().setActiveServer(activeId);
    setActiveServerReachable(false);
    expect(shouldAttemptSubsonicForServer(playbackId, 't1')).toBe(true);
    expect(shouldAttemptSubsonicForServer(playbackId)).toBe(true);
    expect(shouldAttemptSubsonicForServer(activeId)).toBe(false);
  });

  it('uses authoritative non-active runtime reachability when known', () => {
    const playbackId = useAuthStore.getState().addServer({
      name: 'Playback', url: 'http://playback.test', username: 'u', password: 'p',
    });
    const activeId = useAuthStore.getState().addServer({
      name: 'Browse', url: 'http://browse.test', username: 'u', password: 'p',
    });
    useAuthStore.getState().setActiveServer(activeId);
    replaceLibraryServerConnectionSnapshot({ 'playback.test': 'offline' });
    expect(shouldAttemptSubsonicForServer(playbackId)).toBe(false);
  });

  it('never treats unknown non-active reachability as online for unified scope', () => {
    const serverId = useAuthStore.getState().addServer({
      name: 'Other', url: 'http://other.test', username: 'u', password: 'p',
    });
    expect(isSubsonicServerReachableForUnifiedScope(serverId)).toBe(false);
    replaceLibraryServerConnectionSnapshot({ 'other.test': 'online' });
    expect(isSubsonicServerReachableForUnifiedScope(serverId)).toBe(true);
  });

  it('returns false when the track resolves to a local playback url', () => {
    setActiveServerReachable(true);
    hasLocalPlaybackUrlMock.mockReturnValue(true);
    expect(shouldAttemptSubsonicForServer('srv-1', 't1')).toBe(false);
    expect(hasLocalPlaybackUrlMock).toHaveBeenCalledWith('t1', 'srv-1');
  });

  it('returns true for stream playback when the active server is reachable', () => {
    const activeId = useAuthStore.getState().addServer({
      name: 'Active',
      url: 'http://active.test',
      username: 'u',
      password: 'p',
    });
    useAuthStore.getState().setActiveServer(activeId);
    setActiveServerReachable(true);
    expect(shouldAttemptSubsonicForServer(activeId, 't1')).toBe(true);
  });

  it('bypasses the local-url skip when called without a trackId (metadata gate)', () => {
    const activeId = useAuthStore.getState().addServer({
      name: 'Active',
      url: 'http://active.test',
      username: 'u',
      password: 'p',
    });
    useAuthStore.getState().setActiveServer(activeId);
    setActiveServerReachable(true);
    hasLocalPlaybackUrlMock.mockReturnValue(true);
    // Byte-style call (with the track id) is blocked because the bytes are local…
    expect(shouldAttemptSubsonicForServer(activeId, 't1')).toBe(false);
    // …but the metadata gate omits the track id, so it never consults
    // hasLocalPlaybackUrl and stays allowed while the server is reachable.
    expect(shouldAttemptSubsonicForServer(activeId)).toBe(true);
  });
});
