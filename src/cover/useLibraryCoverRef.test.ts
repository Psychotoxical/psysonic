import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  useAlbumCoverRef,
  useArtistCoverRef,
  useDiscCoverRef,
  usePresenceCoverRef,
  useTrackCoverRef,
} from './useLibraryCoverRef';
import { useAuthStore } from '@/store/authStore';
import { rememberAlbumDiscCount } from './ref';
import type { CoverServerScope } from './types';

const navidromeIdentity = {
  type: 'navidrome' as const,
  serverVersion: '0.62.0',
  openSubsonic: true,
};

describe('useTrackCoverRef', () => {
  it('preserves an explicit server scope in the synchronous browse-card path', () => {
    const serverScope: CoverServerScope = {
      kind: 'server',
      serverId: 'srv-owner',
      url: 'https://owner.test',
      username: 'owner',
      password: 'secret',
    };

    const { result } = renderHook(() => useTrackCoverRef(
      {
        id: 'song-1',
        albumId: 'album-1',
        coverArt: 'cover-1',
        discNumber: 1,
      },
      serverScope,
      { libraryResolve: false },
    ));

    expect(result.current?.serverScope).toBe(serverScope);
  });

  it('forceDistinctDiscCovers routes the disc separator to a per-disc slot', () => {
    const serverScope: CoverServerScope = {
      kind: 'server',
      serverId: 'srv-owner',
      url: 'https://owner.test',
      username: 'owner',
      password: 'secret',
    };
    const song = {
      id: 'd2t1',
      albumId: 'al-btw',
      coverArt: 'mf-d2t1_abab',
      discNumber: 2,
    };

    // Without forcing, a per-track mf id collapses to the shared album bucket.
    const albumScoped = renderHook(() =>
      useTrackCoverRef(song, serverScope, { libraryResolve: false }),
    );
    expect(albumScoped.result.current?.cacheEntityId).toBe('al-btw');

    // Forced (as the multi-disc separator does), the disc gets its own cache slot.
    const perDisc = renderHook(() =>
      useTrackCoverRef(song, serverScope, {
        libraryResolve: false,
        forceDistinctDiscCovers: true,
      }),
    );
    expect(perDisc.result.current?.cacheEntityId).toBe('mf-d2t1_abab');
  });

  it('routes to the per-disc dc- slot on a Navidrome multi-disc album', () => {
    const serverId = 'srv-nav-multi';
    useAuthStore.getState().setSubsonicServerIdentity(serverId, navidromeIdentity);
    rememberAlbumDiscCount('al-multi', 2, serverId);
    const scope: CoverServerScope = {
      kind: 'server',
      serverId,
      url: 'https://owner.test',
      username: 'owner',
      password: 'secret',
    };
    const { result } = renderHook(() =>
      useTrackCoverRef(
        { id: 'd2t1', albumId: 'al-multi', coverArt: 'mf-x', discNumber: 2, serverId },
        scope,
        { libraryResolve: true },
      ),
    );
    expect(result.current?.cacheEntityId).toBe('dc-al-multi:2');
    expect(result.current?.fetchCoverArtId).toBe('dc-al-multi:2');
  });

  it('stays album-scoped on browse rails (libraryResolve:false) even when multi-disc', () => {
    const serverId = 'srv-nav-rail';
    useAuthStore.getState().setSubsonicServerIdentity(serverId, navidromeIdentity);
    rememberAlbumDiscCount('al-rail', 2, serverId);
    const scope: CoverServerScope = {
      kind: 'server',
      serverId,
      url: 'https://owner.test',
      username: 'owner',
      password: 'secret',
    };
    const { result } = renderHook(() =>
      useTrackCoverRef(
        { id: 'd2t1', albumId: 'al-rail', coverArt: 'mf-x', discNumber: 2, serverId },
        scope,
        { libraryResolve: false },
      ),
    );
    expect(result.current?.cacheEntityId).toBe('al-rail');
  });

  it('keeps the shared album slot on a Navidrome single-disc album', () => {
    const serverId = 'srv-nav-single';
    useAuthStore.getState().setSubsonicServerIdentity(serverId, navidromeIdentity);
    rememberAlbumDiscCount('al-single', 1, serverId);
    const scope: CoverServerScope = {
      kind: 'server',
      serverId,
      url: 'https://owner.test',
      username: 'owner',
      password: 'secret',
    };
    const { result } = renderHook(() =>
      useTrackCoverRef(
        { id: 't1', albumId: 'al-single', coverArt: 'mf-x', discNumber: 1, serverId },
        scope,
        { libraryResolve: true },
      ),
    );
    expect(result.current?.cacheEntityId).toBe('al-single');
  });

  it('does not use dc- on a non-Navidrome multi-disc album', () => {
    const serverId = 'srv-gonic-multi';
    useAuthStore.getState().setSubsonicServerIdentity(serverId, {
      type: 'gonic',
      serverVersion: '0.16.0',
      openSubsonic: true,
    });
    rememberAlbumDiscCount('al-gonic', 2, serverId);
    const scope: CoverServerScope = {
      kind: 'server',
      serverId,
      url: 'https://owner.test',
      username: 'owner',
      password: 'secret',
    };
    const { result } = renderHook(() =>
      useTrackCoverRef(
        { id: 'd2t1', albumId: 'al-gonic', coverArt: 'mf-x', discNumber: 2, serverId },
        scope,
        { libraryResolve: true },
      ),
    );
    expect(result.current?.cacheEntityId).toBe('al-gonic');
  });
});

describe('useDiscCoverRef', () => {
  const scopeFor = (serverId: string): CoverServerScope => ({
    kind: 'server',
    serverId,
    url: 'https://owner.test',
    username: 'owner',
    password: 'secret',
  });

  it('uses the Navidrome canonical dc-<albumId>:<disc> per-disc slot', () => {
    const serverId = 'srv-navidrome';
    useAuthStore.getState().setSubsonicServerIdentity(serverId, {
      type: 'navidrome',
      serverVersion: '0.62.0',
      openSubsonic: true,
    });
    const song = {
      id: 'd2t1',
      albumId: '0Za0MjhoHc6moGy2RyHga5',
      coverArt: 'mf-d2t1_abab',
      discNumber: 2,
      serverId,
    };
    const { result } = renderHook(() => useDiscCoverRef(song, scopeFor(serverId)));
    expect(result.current?.cacheEntityId).toBe('dc-0Za0MjhoHc6moGy2RyHga5:2');
    expect(result.current?.fetchCoverArtId).toBe('dc-0Za0MjhoHc6moGy2RyHga5:2');
  });

  it('works from the local index (no per-track coverArt) on Navidrome', () => {
    const serverId = 'srv-navidrome-index';
    useAuthStore.getState().setSubsonicServerIdentity(serverId, {
      type: 'navidrome',
      serverVersion: '0.62.0',
      openSubsonic: true,
    });
    const song = { id: 'd2t1', albumId: 'al-btw', discNumber: 2, serverId };
    const { result } = renderHook(() => useDiscCoverRef(song, scopeFor(serverId)));
    expect(result.current?.cacheEntityId).toBe('dc-al-btw:2');
  });

  it('falls back to the disc track cover id on non-Navidrome servers', () => {
    const serverId = 'srv-other';
    useAuthStore.getState().setSubsonicServerIdentity(serverId, {
      type: 'gonic',
      serverVersion: '0.16.0',
      openSubsonic: true,
    });
    const song = {
      id: 'd2t1',
      albumId: 'al-btw',
      coverArt: 'mf-d2t1_abab',
      discNumber: 2,
      serverId,
    };
    const { result } = renderHook(() => useDiscCoverRef(song, scopeFor(serverId)));
    expect(result.current?.cacheEntityId).toBe('mf-d2t1_abab');
  });
});

describe('usePresenceCoverRef', () => {
  const scopeFor = (serverId: string): CoverServerScope => ({
    kind: 'server',
    serverId,
    url: 'https://owner.test',
    username: 'owner',
    password: 'secret',
  });

  it('follows the played disc via dc- on a Navidrome multi-disc album', () => {
    const serverId = 'srv-presence-multi';
    useAuthStore.getState().setSubsonicServerIdentity(serverId, navidromeIdentity);
    rememberAlbumDiscCount('al-presence-multi', 2, serverId);
    const { result } = renderHook(() =>
      usePresenceCoverRef(
        { albumId: 'al-presence-multi', discNumber: 2, serverId },
        scopeFor(serverId),
      ),
    );
    expect(result.current?.cacheEntityId).toBe('dc-al-presence-multi:2');
  });

  it('keeps the shared album slot for a single-disc album (no mf- pollution)', () => {
    const serverId = 'srv-presence-single';
    useAuthStore.getState().setSubsonicServerIdentity(serverId, navidromeIdentity);
    rememberAlbumDiscCount('al-presence-single', 1, serverId);
    const { result } = renderHook(() =>
      usePresenceCoverRef(
        { albumId: 'al-presence-single', discNumber: 1, serverId },
        scopeFor(serverId),
      ),
    );
    expect(result.current?.cacheEntityId).toBe('al-presence-single');
  });
});

describe('useAlbumCoverRef', () => {
  it('preserves an explicit owner scope for album detail covers', () => {
    const serverScope: CoverServerScope = {
      kind: 'server',
      serverId: 'srv-owner',
      url: 'https://owner.test',
      username: 'owner',
      password: 'secret',
    };

    const { result } = renderHook(() => useAlbumCoverRef(
      'album-1',
      'album-cover-1',
      serverScope,
      { libraryResolve: false },
    ));

    expect(result.current?.serverScope).toBe(serverScope);
  });
});

describe('useArtistCoverRef', () => {
  it('preserves an explicit owner scope for artist detail covers', () => {
    const serverScope: CoverServerScope = {
      kind: 'server',
      serverId: 'srv-owner',
      url: 'https://owner.test',
      username: 'owner',
      password: 'secret',
    };

    const { result } = renderHook(() => useArtistCoverRef(
      'artist-1',
      'artist-cover-1',
      serverScope,
      { libraryResolve: false },
    ));

    expect(result.current?.serverScope).toBe(serverScope);
  });
});
