import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import type { ResolvedAlbum } from '@/store/mediaResolver';

function resolvedAlbum(id: string): ResolvedAlbum {
  return {
    album: { id, name: id, artist: 'A', artistId: 'aid', songCount: 0, duration: 0 } satisfies SubsonicAlbum,
    songs: [],
  };
}

// The whole refactor's behavior-preservation rests on three core↔feature seams,
// each with a safe neutral default and a registerX() that swaps in the real impl.
// A2 proves they ARE registered at boot; this file pins the CONTRACT: the exact
// default before registration, and forwarding after. In a fresh module graph
// (isolate: true) importing only the seam module leaves it unregistered — so the
// default assertions run first, then registerX installs a fake.

const { getAlbumForServer } = vi.hoisted(() => ({
  getAlbumForServer: vi.fn(),
}));
vi.mock('@/lib/api/subsonicLibrary', () => ({ getAlbumForServer }));
vi.mock('@/lib/api/subsonicArtists', () => ({ getArtistForServer: vi.fn(async () => null) }));
vi.mock('@/lib/api/subsonicPlaylists', () => ({ getPlaylistForServer: vi.fn(async () => null) }));

// Re-import each seam from a fresh module registry per test so the
// "unregistered default" case never depends on running before the "after
// registerX" case: vi.resetModules() drops the registration a prior test
// installed, making this file order-independent (robust to test reordering /
// sequence.shuffle).
let mediaResolver: typeof import('@/store/mediaResolver');
let orbitRuntime: typeof import('@/store/orbitRuntime');
let playbackEngineBridge: typeof import('@/store/playbackEngineBridge');

beforeEach(async () => {
  vi.resetModules();
  mediaResolver = await import('@/store/mediaResolver');
  orbitRuntime = await import('@/store/orbitRuntime');
  playbackEngineBridge = await import('@/store/playbackEngineBridge');
  getAlbumForServer.mockReset();
  getAlbumForServer.mockResolvedValue(resolvedAlbum('net-album'));
});

describe('mediaResolver seam contract', () => {
  it('default resolveAlbum takes the network-only path', async () => {
    expect(mediaResolver.isMediaResolverRegistered()).toBe(false);
    const out = await mediaResolver.resolveAlbum('srv-1', 'alb-1');
    expect(getAlbumForServer).toHaveBeenCalledWith('srv-1', 'alb-1');
    expect(out).toEqual(resolvedAlbum('net-album'));
  });

  it('after registerMediaResolver, delegates to the registered impl', async () => {
    const fake = {
      resolveAlbum: vi.fn(async () => resolvedAlbum('fake-album')),
      resolveArtist: vi.fn(async () => null),
      resolvePlaylist: vi.fn(async () => null),
    };
    mediaResolver.registerMediaResolver(fake);
    expect(mediaResolver.isMediaResolverRegistered()).toBe(true);
    const out = await mediaResolver.resolveAlbum('srv-1', 'alb-1');
    expect(fake.resolveAlbum).toHaveBeenCalledWith('srv-1', 'alb-1');
    expect(getAlbumForServer).not.toHaveBeenCalled();
    expect(out).toEqual(resolvedAlbum('fake-album'));
  });
});

describe('orbitRuntime seam contract', () => {
  it('default snapshot is neutral and bulkGuard allows', async () => {
    expect(orbitRuntime.isOrbitRuntimeRegistered()).toBe(false);
    expect(orbitRuntime.orbitSnapshot()).toEqual({ role: null, phase: 'idle', state: null });
    await expect(orbitRuntime.orbitBulkGuard(5)).resolves.toBe(true);
  });

  it('after registerOrbitRuntime, delegates snapshot + bulkGuard', async () => {
    const snapshot = { role: 'host' as const, phase: 'active' as const, state: null };
    const bulkGuard = vi.fn(async () => false);
    orbitRuntime.registerOrbitRuntime({ getSnapshot: () => snapshot, bulkGuard });
    expect(orbitRuntime.isOrbitRuntimeRegistered()).toBe(true);
    expect(orbitRuntime.orbitSnapshot()).toEqual(snapshot);
    await expect(orbitRuntime.orbitBulkGuard(9)).resolves.toBe(false);
    expect(bulkGuard).toHaveBeenCalledWith(9);
  });
});

describe('playbackEngineBridge seam contract', () => {
  it('default getQueueServerId is null and ops are no-ops', () => {
    expect(playbackEngineBridge.isPlaybackEngineBridgeRegistered()).toBe(false);
    expect(playbackEngineBridge.getQueueServerId()).toBeNull();
    expect(() => playbackEngineBridge.clearQueueServerForPlayback()).not.toThrow();
    expect(() => playbackEngineBridge.updateReplayGainForCurrentTrack()).not.toThrow();
  });

  it('after registerPlaybackEngineBridge, delegates every op', () => {
    const impl = {
      getQueueServerId: vi.fn(() => 'srv-9'),
      clearQueueServerForPlayback: vi.fn(),
      updateReplayGainForCurrentTrack: vi.fn(),
    };
    playbackEngineBridge.registerPlaybackEngineBridge(impl);
    expect(playbackEngineBridge.isPlaybackEngineBridgeRegistered()).toBe(true);
    expect(playbackEngineBridge.getQueueServerId()).toBe('srv-9');
    playbackEngineBridge.clearQueueServerForPlayback();
    playbackEngineBridge.updateReplayGainForCurrentTrack();
    expect(impl.clearQueueServerForPlayback).toHaveBeenCalledTimes(1);
    expect(impl.updateReplayGainForCurrentTrack).toHaveBeenCalledTimes(1);
  });
});
