import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setActiveServerReachable } from './activeServerReachability';
import { shouldAttemptSubsonicForServer } from './subsonicNetworkGuard';

const resolvePlaybackUrlMock = vi.fn((_trackId: string, _serverId?: string) =>
  'https://music.test/stream',
);

vi.mock('../playback/resolvePlaybackUrl', () => ({
  resolvePlaybackUrl: (trackId: string, serverId?: string) =>
    resolvePlaybackUrlMock(trackId, serverId),
}));

describe('shouldAttemptSubsonicForServer', () => {
  beforeEach(() => {
    setActiveServerReachable(null);
    resolvePlaybackUrlMock.mockReturnValue('https://music.test/stream');
  });

  it('returns false without a server id', () => {
    expect(shouldAttemptSubsonicForServer('')).toBe(false);
  });

  it('returns false when the active server probe failed', () => {
    setActiveServerReachable(false);
    expect(shouldAttemptSubsonicForServer('srv-1', 't1')).toBe(false);
  });

  it('returns false when the track resolves to a local playback url', () => {
    setActiveServerReachable(true);
    resolvePlaybackUrlMock.mockReturnValue('psysonic-local:///favorites/t1.flac');
    expect(shouldAttemptSubsonicForServer('srv-1', 't1')).toBe(false);
    expect(resolvePlaybackUrlMock).toHaveBeenCalledWith('t1', 'srv-1');
  });

  it('returns true for stream playback when the active server is reachable', () => {
    setActiveServerReachable(true);
    expect(shouldAttemptSubsonicForServer('srv-1', 't1')).toBe(true);
  });

  it('bypasses the local-url skip when called without a trackId (metadata gate)', () => {
    setActiveServerReachable(true);
    resolvePlaybackUrlMock.mockReturnValue('psysonic-local:///favorites/t1.flac');
    // Byte-style call (with the track id) is blocked because the bytes are local…
    expect(shouldAttemptSubsonicForServer('srv-1', 't1')).toBe(false);
    // …but the metadata gate omits the track id, so it never consults
    // resolvePlaybackUrl and stays allowed while the server is reachable.
    expect(shouldAttemptSubsonicForServer('srv-1')).toBe(true);
  });
});
