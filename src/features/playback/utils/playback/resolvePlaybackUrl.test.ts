/**
 * `resolvePlaybackUrl` precedence + `streamUrlTrackId` parser tests (Phase F3).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalPlaybackEntry } from '@/store/localPlaybackStore';

const { getLocalUrlMock, entriesMock } = vi.hoisted(() => ({
  getLocalUrlMock: vi.fn(),
  entriesMock: {} as Record<string, LocalPlaybackEntry>,
}));

vi.mock('@/store/localPlaybackStore', () => ({
  useLocalPlaybackStore: {
    getState: () => ({
      getLocalUrl: getLocalUrlMock,
      getEntry: (trackId: string, serverIndexKey: string) =>
        entriesMock[`${serverIndexKey}:${trackId}`] ?? null,
      entries: entriesMock,
    }),
    subscribe: vi.fn(),
  },
}));

import {
  getPlaybackSourceKind,
  resolvePlaybackUrl,
  resolvePlaybackUrlForTrack,
  streamUrlTrackId,
} from '@/features/playback/utils/playback/resolvePlaybackUrl';
import { useAuthStore } from '@/store/authStore';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { queueTrackIdentityKey } from '@/features/playback/utils/playback/queueIdentity';

function seedLibraryEntry(trackId: string, serverIndexKey: string, localPath: string): void {
  entriesMock[`${serverIndexKey}:${trackId}`] = {
    serverIndexKey,
    trackId,
    localPath,
    layoutFingerprint: '',
    sizeBytes: 1,
    tier: 'library',
    cachedAt: 1,
    suffix: 'flac',
  };
}

beforeEach(() => {
  resetAuthStore();
  Object.keys(entriesMock).forEach(k => delete entriesMock[k]);
  getLocalUrlMock.mockReset();
  getLocalUrlMock.mockReturnValue(null);
  const id = useAuthStore.getState().addServer({
    name: 'Test', url: 'https://music.example.com', username: 'alice', password: 'pw',
  });
  useAuthStore.getState().setActiveServer(id);
});

describe('resolvePlaybackUrl — precedence', () => {
  it('returns the library-tier URL when present (1st priority)', () => {
    seedLibraryEntry('track-1', 'srv-1', '/library/track-1.flac');
    expect(resolvePlaybackUrl('track-1', 'srv-1')).toBe('psysonic-local:///library/track-1.flac');
  });

  it('returns favorite-auto URL when library is absent (2nd priority)', () => {
    entriesMock['srv-1:track-1'] = {
      serverIndexKey: 'srv-1',
      trackId: 'track-1',
      localPath: '/favorites/track-1.flac',
      layoutFingerprint: '',
      sizeBytes: 1,
      tier: 'favorite-auto',
      cachedAt: 1,
      suffix: 'flac',
    };
    expect(resolvePlaybackUrl('track-1', 'srv-1')).toBe('psysonic-local:///favorites/track-1.flac');
  });

  it('falls through to ephemeral cache when library and favorites are absent (3rd priority)', () => {
    getLocalUrlMock.mockImplementation(
      (_tid: string, _sid: string, tier?: string) => (
        tier === 'ephemeral' ? 'psysonic-local://hot/track-1.flac' : null
      ),
    );
    expect(resolvePlaybackUrl('track-1', 'srv-1')).toBe('psysonic-local://hot/track-1.flac');
  });

  it('falls through to the HTTP stream URL when neither local source is present', () => {
    const url = resolvePlaybackUrl('track-1', 'srv-1');
    expect(url).toMatch(/^https:\/\/music\.example\.com\/rest\/stream\.view\?/);
    expect(url).toContain('id=track-1');
  });


  /** Per-address model: cap applies only to Navidrome-confirmed servers,
   *  keyed by the normalized address the connect layer resolves. */
  function setCapForActiveServer(kbps: number, opts: { navidrome?: boolean } = {}): void {
    const st = useAuthStore.getState();
    const srv = st.getActiveServer()!;
    st.setSubsonicServerIdentity(srv.id, { type: opts.navidrome === false ? 'generic' : 'navidrome' });
    st.setStreamQualityForAddress('https://music.example.com', kbps as 0);
  }

  it('omits maxBitRate on the stream URL when quality is Original (default)', () => {
    const url = resolvePlaybackUrl('track-1', 'srv-1');
    expect(url).not.toContain('maxBitRate');
  });

  it('appends the maxBitRate cap on the stream URL when a quality is set', () => {
    setCapForActiveServer(192);
    const url = resolvePlaybackUrl('track-1', 'srv-1');
    expect(url).toContain('maxBitRate=192');
  });

  it('ignores the cap when the server identity is not Navidrome', () => {
    setCapForActiveServer(192, { navidrome: false });
    const url = resolvePlaybackUrl('track-1', 'srv-1');
    expect(url).not.toContain('maxBitRate');
  });

  it('does not cap a locally cached track (cap only applies to live streams)', () => {
    seedLibraryEntry('track-1', 'srv-1', '/library/track-1.flac');
    setCapForActiveServer(128);
    const url = resolvePlaybackUrl('track-1', 'srv-1');
    expect(url).toBe('psysonic-local:///library/track-1.flac');
    expect(url).not.toContain('maxBitRate');
  });

  // #3 (cucadmuh): a hot-cache blob captured from a capped live stream must not
  // be reused when the current quality differs — otherwise a 128 kbps blob is
  // served for an Original request.
  function seedEphemeral(trackId: string, capKbps: number): void {
    entriesMock[`srv-1:${trackId}`] = {
      serverIndexKey: 'srv-1', trackId, localPath: `/hot/${trackId}.mp3`,
      layoutFingerprint: '', sizeBytes: 1, tier: 'ephemeral', cachedAt: 1,
      suffix: 'mp3', streamMaxBitRateKbps: capKbps,
    };
    getLocalUrlMock.mockImplementation(
      (tid: string, _sid: string, tier?: string) =>
        (tier === 'ephemeral' && tid === trackId ? `psysonic-local://hot/${trackId}.mp3` : null),
    );
  }

  it('does NOT serve a 128 kbps hot-cache blob for an Original request', () => {
    seedEphemeral('track-1', 128);
    setCapForActiveServer(0); // Original
    const url = resolvePlaybackUrl('track-1', 'srv-1');
    expect(url).toMatch(/stream\.view/);
    expect(url).not.toContain('psysonic-local');
  });

  it('reuses a hot-cache blob when the cached quality matches the current cap', () => {
    seedEphemeral('track-1', 128);
    setCapForActiveServer(128);
    expect(resolvePlaybackUrl('track-1', 'srv-1')).toBe('psysonic-local://hot/track-1.mp3');
  });

  it('always reuses an original hot-cache blob regardless of the cap', () => {
    seedEphemeral('track-1', 0); // cached at original
    setCapForActiveServer(128);
    expect(resolvePlaybackUrl('track-1', 'srv-1')).toBe('psysonic-local://hot/track-1.mp3');
  });
});

describe('resolvePlaybackUrlForTrack', () => {
  it('returns directStreamUrl when set on the track', () => {
    const url = resolvePlaybackUrlForTrack(
      {
        id: 'ndshare:abc:0',
        directStreamUrl: 'https://music.example.com/share/s/jwt-token',
      },
      'navidrome-public-share',
    );
    expect(url).toBe('https://music.example.com/share/s/jwt-token');
  });
});

describe('getPlaybackSourceKind', () => {
  it('returns "offline" when the library tier has the track', () => {
    seedLibraryEntry('t1', 'srv-1', '/library/t1.flac');
    expect(getPlaybackSourceKind('t1', 'srv-1')).toBe('offline');
  });

  it('returns "hot" when only ephemeral cache has the track', () => {
    getLocalUrlMock.mockImplementation(
      (_tid: string, _sid: string, tier?: string) => (
        tier === 'ephemeral' ? 'psysonic-local://hot/t1.flac' : null
      ),
    );
    expect(getPlaybackSourceKind('t1', 'srv-1')).toBe('hot');
  });

  it('returns "stream" when neither has the track and no engine preload hint matches', () => {
    expect(getPlaybackSourceKind('t1', 'srv-1')).toBe('stream');
  });

  it('returns "hot" when the engine reported a preload for this trackId (RAM-loaded)', () => {
    expect(getPlaybackSourceKind('t1', 'srv-1', 't1')).toBe('hot');
  });

  it('does not reuse a server-qualified preload from another owner', () => {
    const preloadIdentity = queueTrackIdentityKey('t1', 'srv-other');
    expect(getPlaybackSourceKind('t1', 'srv-1', preloadIdentity)).toBe('stream');
  });
});

describe('streamUrlTrackId', () => {
  it('extracts the id query param from a stream.view URL', () => {
    const url = 'https://music.example.com/rest/stream.view?id=track-1&u=alice&t=hash';
    expect(streamUrlTrackId(url)).toBe('track-1');
  });

  it('returns null for URLs that are not stream.view', () => {
    expect(streamUrlTrackId('https://music.example.com/rest/getCoverArt.view?id=cover')).toBeNull();
  });
});
