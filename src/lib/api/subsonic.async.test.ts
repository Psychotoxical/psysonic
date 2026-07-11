/**
 * Async-endpoint contract tests for `subsonic.ts` (F3 follow-up).
 *
 * Mocks `axios` at the module boundary and verifies the response
 * normalization paths the rest of the app depends on:
 *   - subsonic-response unwrap + status=ok check
 *   - error mapping (no envelope, status=failed, network error)
 *   - song-array vs single-object normalization (Subsonic's XML→JSON
 *     emits one-element collections as a bare object)
 *   - empty / missing collection fallbacks → []
 *   - explicit-credential variants (pingWithCredentials)
 *
 * Pure URL builders + auth params are pinned in
 * `subsonic.contract.test.ts`. This file complements that with the
 * networking surface the structural tests skipped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('axios', () => ({
  default: { get: vi.fn() },
}));

vi.mock('@/lib/network/subsonicNetworkGuard', () => ({
  shouldAttemptSubsonicForActiveServer: () => true,
  shouldAttemptSubsonicForServer: () => true,
}));

import axios from 'axios';
import { onInvoke } from '@/test/mocks/tauri';
import { pingWithCredentials, pingWithCredentialsForProfile, ping } from '@/lib/api/subsonic';
import { getAlbumInfo2 } from '@/lib/api/subsonicAlbumInfo';
import { getStarred } from '@/lib/api/subsonicStarRating';
import { search } from '@/lib/api/subsonicSearch';
import { getAlbum, getMusicDirectory, getMusicFolders, getMusicIndexes, getRandomSongs, getSong } from '@/lib/api/subsonicLibrary';
import { getArtists, getTopSongs } from '@/lib/api/subsonicArtists';
import { useAuthStore } from '@/store/authStore';
import { resetAuthStore } from '@/test/helpers/storeReset';

function setUpServer(): string {
  const id = useAuthStore.getState().addServer({
    name: 'Test', url: 'https://music.example.com', username: 'alice', password: 'pw',
  });
  useAuthStore.getState().setActiveServer(id);
  return id;
}

function okResponse(payload: Record<string, unknown>) {
  return {
    data: {
      'subsonic-response': { status: 'ok', ...payload },
    },
  };
}

function errorResponse(message = 'Subsonic error', code = 50) {
  return {
    data: {
      'subsonic-response': {
        status: 'failed',
        error: { code, message },
      },
    },
  };
}

beforeEach(() => {
  resetAuthStore();
  setUpServer();
  vi.mocked(axios.get).mockReset();
});

afterEach(() => {
  vi.mocked(axios.get).mockReset();
});

describe('api() helper — response envelope', () => {
  it('unwraps the subsonic-response envelope on status=ok', async () => {
    vi.mocked(axios.get).mockResolvedValue(
      okResponse({ randomSongs: { song: [] } }),
    );
    await expect(getRandomSongs()).resolves.toEqual([]);
  });

  it('throws "Invalid response" when there is no subsonic-response envelope', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { not: 'subsonic' } });
    await expect(getRandomSongs()).rejects.toThrow(/invalid response/i);
  });

  it('throws the server error message when status=failed', async () => {
    vi.mocked(axios.get).mockResolvedValue(errorResponse('Wrong username or password'));
    await expect(getRandomSongs()).rejects.toThrow(/wrong username/i);
  });

  it('throws a generic message when status=failed without an error.message', async () => {
    vi.mocked(axios.get).mockResolvedValue({
      data: { 'subsonic-response': { status: 'failed', error: {} } },
    });
    await expect(getRandomSongs()).rejects.toThrow(/subsonic api error/i);
  });

  it('propagates network failures (axios reject) to the caller', async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(getRandomSongs()).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe('getRandomSongs — pass-through behaviour', () => {
  // Navidrome's randomSongs endpoint always returns the `song` field as
  // an array (`getRandomSongs` doesn't normalize single objects). The
  // tests below pin the array + empty-fallback paths; the single-object
  // path is intentionally untested because no production server returns it.

  it('returns an empty array when randomSongs.song is missing entirely', async () => {
    vi.mocked(axios.get).mockResolvedValue(okResponse({ randomSongs: {} }));
    const songs = await getRandomSongs();
    expect(songs).toEqual([]);
  });

  it('passes a song-array through unchanged', async () => {
    vi.mocked(axios.get).mockResolvedValue(
      okResponse({
        randomSongs: {
          song: [
            { id: 'a', title: 'A', artist: 'Ar', album: 'Al', albumId: 'al-1', duration: 100 },
            { id: 'b', title: 'B', artist: 'Ar', album: 'Al', albumId: 'al-1', duration: 110 },
          ],
        },
      }),
    );
    const songs = await getRandomSongs();
    expect(songs).toHaveLength(2);
    expect(songs.map(s => s.id)).toEqual(['a', 'b']);
  });

  it('forwards a custom size to the query params', async () => {
    vi.mocked(axios.get).mockResolvedValue(okResponse({ randomSongs: { song: [] } }));
    await getRandomSongs(25);
    const params = vi.mocked(axios.get).mock.calls[0]?.[1]?.params as Record<string, unknown>;
    expect(params.size).toBe(25);
  });

  it('forwards a genre filter when provided', async () => {
    vi.mocked(axios.get).mockResolvedValue(okResponse({ randomSongs: { song: [] } }));
    await getRandomSongs(10, 'Rock');
    const params = vi.mocked(axios.get).mock.calls[0]?.[1]?.params as Record<string, unknown>;
    expect(params.genre).toBe('Rock');
  });
});

describe('getAlbum', () => {
  beforeEach(() => {
    onInvoke('library_patch_album', () => undefined);
  });

  it('splits the response into { album, songs }', async () => {
    vi.mocked(axios.get).mockResolvedValue(
      okResponse({
        album: {
          id: 'al-1', name: 'Album', artist: 'Ar', artistId: 'ar-1', songCount: 2, duration: 200,
          song: [
            { id: 's1', title: 'S1', artist: 'Ar', album: 'Album', albumId: 'al-1', duration: 100 },
            { id: 's2', title: 'S2', artist: 'Ar', album: 'Album', albumId: 'al-1', duration: 100 },
          ],
        },
      }),
    );
    const { album, songs } = await getAlbum('al-1');
    expect(album.id).toBe('al-1');
    expect(album.songCount).toBe(2);
    expect(songs).toHaveLength(2);
    // The destructure removes `song` from the album payload.
    expect((album as unknown as Record<string, unknown>).song).toBeUndefined();
  });

  it('returns an empty songs array when the album has no songs', async () => {
    vi.mocked(axios.get).mockResolvedValue(
      okResponse({
        album: { id: 'al-empty', name: 'Empty', artist: 'Ar', artistId: 'ar-1', songCount: 0, duration: 0 },
      }),
    );
    const { songs } = await getAlbum('al-empty');
    expect(songs).toEqual([]);
  });
});

describe('getMusicDirectory + getMusicIndexes + getMusicFolders', () => {
  it('getMusicDirectory normalizes child to an array', async () => {
    vi.mocked(axios.get).mockResolvedValue(
      okResponse({
        directory: {
          id: 'd1', name: 'Music',
          // Single child as object (not array).
          child: { id: 'c1', title: 'Sub', isDir: true },
        },
      }),
    );
    const dir = await getMusicDirectory('d1');
    expect(dir.id).toBe('d1');
    expect(dir.child).toHaveLength(1);
    expect(dir.child[0]?.id).toBe('c1');
  });

  it('getMusicDirectory returns empty child[] when the field is absent', async () => {
    vi.mocked(axios.get).mockResolvedValue(
      okResponse({ directory: { id: 'd2', name: 'Empty' } }),
    );
    const dir = await getMusicDirectory('d2');
    expect(dir.child).toEqual([]);
  });

  it('getMusicIndexes flattens nested artist arrays into directory entries', async () => {
    vi.mocked(axios.get).mockResolvedValue(
      okResponse({
        indexes: {
          index: [
            { name: 'A', artist: [{ id: 'ar-a1', name: 'A1' }, { id: 'ar-a2', name: 'A2' }] },
            { name: 'B', artist: { id: 'ar-b1', name: 'B1' } },
          ],
        },
      }),
    );
    const entries = await getMusicIndexes('1');
    expect(entries.map(e => e.id)).toEqual(['ar-a1', 'ar-a2', 'ar-b1']);
  });

  it('getMusicIndexes handles a missing index field as empty', async () => {
    vi.mocked(axios.get).mockResolvedValue(okResponse({ indexes: {} }));
    expect(await getMusicIndexes('1')).toEqual([]);
  });

  it('getMusicFolders coerces numeric ids to strings + defaults the name', async () => {
    vi.mocked(axios.get).mockResolvedValue(
      okResponse({
        musicFolders: {
          musicFolder: [
            { id: 1, name: 'Music' },
            { id: 2 }, // missing name → default
          ],
        },
      }),
    );
    const folders = await getMusicFolders();
    expect(folders).toEqual([
      { id: '1', name: 'Music' },
      { id: '2', name: 'Library' },
    ]);
  });
});

describe('getSong', () => {
  it('returns the song payload', async () => {
    vi.mocked(axios.get).mockResolvedValue(
      okResponse({ song: { id: 's1', title: 'T', artist: 'A', album: 'Al', albumId: 'al-1', duration: 100 } }),
    );
    const song = await getSong('s1');
    expect(song?.id).toBe('s1');
  });

  it('returns null on any failure (network or subsonic error)', async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error('boom'));
    await expect(getSong('whatever')).resolves.toBeNull();
  });
});

describe('getStarred', () => {
  it('returns empty arrays when starred2 has no entries', async () => {
    vi.mocked(axios.get).mockResolvedValue(okResponse({ starred2: {} }));
    const result = await getStarred();
    expect(result.songs).toEqual([]);
    expect(result.albums).toEqual([]);
    expect(result.artists).toEqual([]);
  });

  it('returns empty arrays when starred2 itself is missing', async () => {
    vi.mocked(axios.get).mockResolvedValue(okResponse({}));
    const result = await getStarred();
    expect(result.songs).toEqual([]);
    expect(result.albums).toEqual([]);
    expect(result.artists).toEqual([]);
  });

  it('passes the three array buckets through unchanged', async () => {
    vi.mocked(axios.get).mockResolvedValue(
      okResponse({
        starred2: {
          song: [{ id: 's1', title: 'T', artist: 'A', album: 'Al', albumId: 'al-1', duration: 100 }],
          album: [{ id: 'al-1', name: 'Al', artist: 'A', artistId: 'ar-1', songCount: 1, duration: 100 }],
          artist: [{ id: 'ar-1', name: 'Artist' }],
        },
      }),
    );
    const result = await getStarred();
    expect(result.songs).toHaveLength(1);
    expect(result.albums).toHaveLength(1);
    expect(result.artists).toHaveLength(1);
  });
});

describe('getTopSongs', () => {
  it('returns an empty array when topSongs.song is absent', async () => {
    vi.mocked(axios.get).mockResolvedValue(okResponse({ topSongs: {} }));
    expect(await getTopSongs('Nirvana')).toEqual([]);
  });

  it('passes a song-array through and slices to 5', async () => {
    const song = { id: 's', title: 'T', artist: 'A', album: 'Al', albumId: 'al-1', duration: 100 };
    vi.mocked(axios.get).mockResolvedValue(
      okResponse({ topSongs: { song: Array.from({ length: 8 }, (_, i) => ({ ...song, id: `s${i}` })) } }),
    );
    const songs = await getTopSongs('Nirvana');
    expect(songs).toHaveLength(5);
  });

  it('returns [] on any failure (catch swallows)', async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error('boom'));
    expect(await getTopSongs('Nirvana')).toEqual([]);
  });
});

describe('getArtists', () => {
  it('flattens index→artist arrays', async () => {
    vi.mocked(axios.get).mockResolvedValue(
      okResponse({
        artists: {
          index: [
            { name: 'A', artist: [{ id: 'a1', name: 'Alpha' }] },
            { name: 'B', artist: { id: 'b1', name: 'Beta' } },
          ],
        },
      }),
    );
    const artists = await getArtists();
    expect(artists.map(a => a.id)).toEqual(['a1', 'b1']);
  });

  it('returns empty when index is absent', async () => {
    vi.mocked(axios.get).mockResolvedValue(okResponse({ artists: {} }));
    expect(await getArtists()).toEqual([]);
  });
});

describe('search', () => {
  it('returns empty arrays when searchResult3 is empty', async () => {
    vi.mocked(axios.get).mockResolvedValue(okResponse({ searchResult3: {} }));
    const r = await search('nothing');
    expect(r.songs).toEqual([]);
    expect(r.albums).toEqual([]);
    expect(r.artists).toEqual([]);
  });

  it('short-circuits to empty arrays for a whitespace-only query (no HTTP)', async () => {
    const r = await search('   ');
    expect(r.songs).toEqual([]);
    expect(r.albums).toEqual([]);
    expect(r.artists).toEqual([]);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('passes array result types through unchanged', async () => {
    vi.mocked(axios.get).mockResolvedValue(
      okResponse({
        searchResult3: {
          song: [{ id: 's1', title: 'T', artist: 'A', album: 'Al', albumId: 'al-1', duration: 100 }],
          album: [{ id: 'al-1', name: 'Al', artist: 'A', artistId: 'ar-1', songCount: 1, duration: 100 }],
          artist: [{ id: 'ar-1', name: 'Artist' }],
        },
      }),
    );
    const r = await search('q');
    expect(r.songs).toHaveLength(1);
    expect(r.albums).toHaveLength(1);
    expect(r.artists).toHaveLength(1);
  });
});

describe('getAlbumInfo2', () => {
  it('returns the albumInfo payload', async () => {
    vi.mocked(axios.get).mockResolvedValue(
      okResponse({ albumInfo: { largeImageUrl: 'https://x', notes: 'about' } }),
    );
    const info = await getAlbumInfo2('al-1');
    expect(info?.largeImageUrl).toBe('https://x');
  });

  it('returns null on any failure (server error / network)', async () => {
    vi.mocked(axios.get).mockResolvedValue(errorResponse('not found'));
    expect(await getAlbumInfo2('missing')).toBeNull();
  });
});

describe('ping', () => {
  it('returns true when the server replies with status=ok', async () => {
    vi.mocked(axios.get).mockResolvedValue(okResponse({}));
    expect(await ping()).toBe(true);
  });

  it('returns false on any failure', async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error('boom'));
    expect(await ping()).toBe(false);
  });
});

describe('pingWithCredentials — explicit URL/credentials path', () => {
  it('returns ok=true with type + serverVersion + openSubsonic when present', async () => {
    vi.mocked(axios.get).mockResolvedValue(
      okResponse({ type: 'navidrome', serverVersion: '0.55', openSubsonic: true }),
    );
    const r = await pingWithCredentials('https://music.example.com', 'u', 'p');
    expect(r.ok).toBe(true);
    expect(r.type).toBe('navidrome');
    expect(r.serverVersion).toBe('0.55');
    expect(r.openSubsonic).toBe(true);
  });

  it('prepends http:// when the URL lacks a scheme', async () => {
    vi.mocked(axios.get).mockResolvedValue(okResponse({}));
    await pingWithCredentials('music.local', 'u', 'p');
    const calledUrl = vi.mocked(axios.get).mock.calls[0]?.[0] as string;
    expect(calledUrl.startsWith('http://music.local')).toBe(true);
  });

  it('strips a trailing slash before appending /rest/ping.view', async () => {
    vi.mocked(axios.get).mockResolvedValue(okResponse({}));
    await pingWithCredentials('https://music.example.com/', 'u', 'p');
    const calledUrl = vi.mocked(axios.get).mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe('https://music.example.com/rest/ping.view');
  });

  it('returns ok=false (no throw) on any failure', async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await pingWithCredentials('https://x.test', 'u', 'p');
    expect(r.ok).toBe(false);
    expect(r.type).toBeUndefined();
  });

  it('returns ok=false when the response status is not "ok"', async () => {
    vi.mocked(axios.get).mockResolvedValue(errorResponse());
    const r = await pingWithCredentials('https://x.test', 'u', 'wrong-pw');
    expect(r.ok).toBe(false);
  });

  it('coerces openSubsonic=true even when the field is omitted (defaults to false)', async () => {
    vi.mocked(axios.get).mockResolvedValue(okResponse({}));
    const r = await pingWithCredentials('https://x.test', 'u', 'p');
    expect(r.openSubsonic).toBe(false);
  });
});

describe('pingWithCredentialsForProfile — custom gate headers (native probe)', () => {
  // Gate-header servers probe over the native reqwest command, not the WebView
  // axios path, so a non-safelisted header (CF-Access / Pangolin token) can't
  // trip a CORS preflight the gate would reject. See `probe_server_connection`.
  type ProbeArgs = {
    baseUrl: string;
    username: string;
    password: string;
    httpContext: {
      endpoints: { url: string; kind: string }[];
      customHeaders: { name: string; value: string }[];
      customHeadersApplyTo: string;
    } | null;
  };

  it('routes header-bearing probes through the native command with the full header context', async () => {
    let received: ProbeArgs | undefined;
    onInvoke('probe_server_connection', (args) => {
      received = args as ProbeArgs;
      return { ok: true, type: 'navidrome', serverVersion: '0.62.0', openSubsonic: true };
    });

    const result = await pingWithCredentialsForProfile(
      {
        url: 'https://music.example.com',
        alternateUrl: 'http://192.168.0.10:4533',
        username: 'u',
        password: 'p',
        customHeaders: [{ name: 'CF-Access-Client-Secret', value: 'gate-secret' }],
        customHeadersApplyTo: 'public',
      },
      'https://music.example.com',
    );

    // No WebView request for gate-header servers.
    expect(axios.get).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, type: 'navidrome', serverVersion: '0.62.0', openSubsonic: true });
    expect(received?.baseUrl).toBe('https://music.example.com');
    expect(received?.httpContext?.customHeaders).toEqual([
      { name: 'CF-Access-Client-Secret', value: 'gate-secret' },
    ]);
    expect(received?.httpContext?.customHeadersApplyTo).toBe('public');
    // Both dual-address endpoints are forwarded so the native resolver applies
    // the header per-endpoint (public only, here).
    expect(received?.httpContext?.endpoints).toEqual([
      { url: 'http://192.168.0.10:4533', kind: 'local' },
      { url: 'https://music.example.com', kind: 'public' },
    ]);
  });

  it('still probes the LAN endpoint through the native command (header omission delegated to Rust)', async () => {
    let received: ProbeArgs | undefined;
    onInvoke('probe_server_connection', (args) => {
      received = args as ProbeArgs;
      return { ok: true, type: null, serverVersion: null, openSubsonic: false };
    });

    await pingWithCredentialsForProfile(
      {
        url: 'https://music.example.com',
        alternateUrl: 'http://192.168.0.10:4533',
        username: 'u',
        password: 'p',
        customHeaders: [{ name: 'CF-Access-Client-Secret', value: 'gate-secret' }],
        customHeadersApplyTo: 'public',
      },
      'http://192.168.0.10:4533',
    );

    expect(axios.get).not.toHaveBeenCalled();
    expect(received?.baseUrl).toBe('http://192.168.0.10:4533');
  });

  it('returns ok=false when the native probe errors', async () => {
    onInvoke('probe_server_connection', () => {
      throw new Error('gate rejected');
    });
    const r = await pingWithCredentialsForProfile(
      {
        url: 'https://music.example.com',
        username: 'u',
        password: 'p',
        customHeaders: [{ name: 'CF-Access-Client-Secret', value: 'gate-secret' }],
        customHeadersApplyTo: 'public',
      },
      'https://music.example.com',
    );
    expect(r.ok).toBe(false);
  });

  it('surfaces the server-supplied failure reason so the add form can show it', async () => {
    onInvoke('probe_server_connection', () => ({
      ok: false,
      type: null,
      serverVersion: null,
      openSubsonic: false,
      error: 'Wrong username or password',
    }));
    const r = await pingWithCredentialsForProfile(
      {
        url: 'https://music.example.com',
        username: 'u',
        password: 'wrong',
        customHeaders: [{ name: 'CF-Access-Client-Secret', value: 'gate-secret' }],
        customHeadersApplyTo: 'public',
      },
      'https://music.example.com',
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Wrong username or password');
  });

  it('keeps the WebView axios path for header-less servers', async () => {
    vi.mocked(axios.get).mockResolvedValue(okResponse({ type: 'navidrome' }));
    const r = await pingWithCredentialsForProfile(
      { url: 'https://music.example.com', username: 'u', password: 'p' },
      'https://music.example.com',
    );
    expect(r.ok).toBe(true);
    expect(axios.get).toHaveBeenCalledTimes(1);
    const calledUrl = vi.mocked(axios.get).mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe('https://music.example.com/rest/ping.view');
  });

  it('carries the server error message on the header-less axios path too', async () => {
    vi.mocked(axios.get).mockResolvedValue(errorResponse('Wrong username or password', 40));
    const r = await pingWithCredentialsForProfile(
      { url: 'https://music.example.com', username: 'u', password: 'wrong' },
      'https://music.example.com',
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Wrong username or password');
  });
});

describe('api() transport routing — gated servers use the native proxy', () => {
  // Browse / stats / search all funnel through `api()` → axios in the WebView.
  // For gate-header servers that axios request dies on a CORS preflight, so the
  // transport must switch to the native `subsonic_proxy_request` command. This
  // pins that routing decision (and the header-less axios path staying put).
  type ProxyArgs = {
    baseUrl: string;
    endpoint: string;
    params: [string, string][];
    postForm: boolean;
    httpContext: { customHeaders: { name: string; value: string }[] } | null;
  };

  function addGatedActiveServer() {
    resetAuthStore();
    const id = useAuthStore.getState().addServer({
      name: 'Gated',
      url: 'https://gated.example.com',
      username: 'u',
      password: 'p',
      customHeaders: [{ name: 'CF-Access-Client-Secret', value: 'gate-secret' }],
      customHeadersApplyTo: 'public',
    });
    useAuthStore.getState().setActiveServer(id);
  }

  it('routes getAlbumList2 through the native command with the gate header context', async () => {
    addGatedActiveServer();
    let received: ProxyArgs | undefined;
    onInvoke('subsonic_proxy_request', (args) => {
      received = args as ProxyArgs;
      return JSON.stringify({
        'subsonic-response': { status: 'ok', randomSongs: { song: [] } },
      });
    });

    const songs = await getRandomSongs();

    expect(songs).toEqual([]);
    expect(axios.get).not.toHaveBeenCalled();
    expect(received?.endpoint).toBe('getRandomSongs.view');
    expect(received?.baseUrl).toBe('https://gated.example.com');
    expect(received?.httpContext?.customHeaders).toEqual([
      { name: 'CF-Access-Client-Secret', value: 'gate-secret' },
    ]);
    // Auth params still ride in the forwarded query.
    expect(received?.params.some(([k]) => k === 'u')).toBe(true);
  });

  it('propagates a server failure envelope from the proxied body', async () => {
    addGatedActiveServer();
    onInvoke('subsonic_proxy_request', () =>
      JSON.stringify({
        'subsonic-response': { status: 'failed', error: { code: 40, message: 'Wrong username or password' } },
      }),
    );
    await expect(getRandomSongs()).rejects.toThrow(/wrong username/i);
  });

  it('keeps the WebView axios path for header-less active servers', async () => {
    resetAuthStore();
    const id = useAuthStore.getState().addServer({
      name: 'Plain', url: 'https://plain.example.com', username: 'u', password: 'p',
    });
    useAuthStore.getState().setActiveServer(id);
    vi.mocked(axios.get).mockResolvedValue(okResponse({ randomSongs: { song: [] } }));
    let proxyCalled = false;
    onInvoke('subsonic_proxy_request', () => {
      proxyCalled = true;
      return JSON.stringify({ 'subsonic-response': { status: 'ok' } });
    });

    await getRandomSongs();

    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(proxyCalled).toBe(false);
  });
});
