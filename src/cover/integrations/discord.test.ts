import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api/subsonicAlbumInfo', () => ({
  getAlbumInfo2: vi.fn(),
}));

import { getAlbumInfo2 } from '@/lib/api/subsonicAlbumInfo';
import { sanitizeDiscordCoverUrl, resolveServerCoverForDiscord } from './discord';

const mockedGetAlbumInfo2 = vi.mocked(getAlbumInfo2);

describe('sanitizeDiscordCoverUrl', () => {
  it('accepts a plain public https url', () => {
    expect(sanitizeDiscordCoverUrl('https://music.example.com/share/img/eyJhbGciOiJIUzI1NiJ9.abc?size=1200'))
      .toBe('https://music.example.com/share/img/eyJhbGciOiJIUzI1NiJ9.abc?size=1200');
  });

  it('rejects null / undefined / empty input', () => {
    expect(sanitizeDiscordCoverUrl(null)).toBeNull();
    expect(sanitizeDiscordCoverUrl(undefined)).toBeNull();
    expect(sanitizeDiscordCoverUrl('')).toBeNull();
  });

  it('rejects malformed URLs', () => {
    expect(sanitizeDiscordCoverUrl('not a url')).toBeNull();
  });

  it('rejects non-https schemes', () => {
    expect(sanitizeDiscordCoverUrl('http://music.example.com/share/img/abc')).toBeNull();
  });

  it('rejects URLs carrying embedded userinfo', () => {
    expect(sanitizeDiscordCoverUrl('https://alice:secret@music.example.com/share/img/abc')).toBeNull();
  });

  it('rejects a credentialed Subsonic getCoverArt URL (the original leak, PR #1246)', () => {
    expect(
      sanitizeDiscordCoverUrl(
        'https://music.example.com/rest/getCoverArt.view?id=al-1&u=alice&t=deadbeef&s=abc123',
      ),
    ).toBeNull();
  });

  it('rejects credentialed query params regardless of key case', () => {
    expect(
      sanitizeDiscordCoverUrl('https://music.example.com/rest/getCoverArt.view?id=al-1&U=alice&T=deadbeef&S=abc123'),
    ).toBeNull();
  });

  it('rejects an apiKey-style credential param', () => {
    expect(sanitizeDiscordCoverUrl('https://music.example.com/img/al-1?apiKey=secret')).toBeNull();
  });

  it('rejects LAN / loopback hosts', () => {
    expect(sanitizeDiscordCoverUrl('https://192.168.1.5/share/img/abc')).toBeNull();
    expect(sanitizeDiscordCoverUrl('https://localhost/share/img/abc')).toBeNull();
  });
});

describe('resolveServerCoverForDiscord', () => {
  beforeEach(() => {
    mockedGetAlbumInfo2.mockReset();
  });

  it('prefers largeImageUrl, falling back to medium then small', async () => {
    mockedGetAlbumInfo2.mockResolvedValueOnce({
      largeImageUrl: 'https://music.example.com/img/large.jpg',
      mediumImageUrl: 'https://music.example.com/img/medium.jpg',
    });
    expect(await resolveServerCoverForDiscord('al-large', null)).toBe('https://music.example.com/img/large.jpg');

    mockedGetAlbumInfo2.mockResolvedValueOnce({
      mediumImageUrl: 'https://music.example.com/img/medium.jpg',
    });
    expect(await resolveServerCoverForDiscord('al-medium', null)).toBe('https://music.example.com/img/medium.jpg');

    mockedGetAlbumInfo2.mockResolvedValueOnce({
      smallImageUrl: 'https://music.example.com/img/small.jpg',
    });
    expect(await resolveServerCoverForDiscord('al-small', null)).toBe('https://music.example.com/img/small.jpg');
  });

  it('returns null and caches the negative result when getAlbumInfo2 has no images', async () => {
    mockedGetAlbumInfo2.mockResolvedValue(null);
    expect(await resolveServerCoverForDiscord('al-none', null)).toBeNull();
    expect(await resolveServerCoverForDiscord('al-none', null)).toBeNull();
    // Second call for the same albumId must hit the cache, not the API again.
    expect(mockedGetAlbumInfo2).toHaveBeenCalledTimes(1);
  });

  it('caches a successful resolution — subsequent calls skip the API', async () => {
    mockedGetAlbumInfo2.mockResolvedValue({ largeImageUrl: 'https://music.example.com/img/cached.jpg' });
    await resolveServerCoverForDiscord('al-cache', null);
    await resolveServerCoverForDiscord('al-cache', null);
    expect(mockedGetAlbumInfo2).toHaveBeenCalledTimes(1);
  });

  it('rewrites a LAN-scoped response origin to the public share base, keeping path + query', async () => {
    mockedGetAlbumInfo2.mockResolvedValueOnce({
      largeImageUrl: 'https://192.168.1.5:4533/share/img/eyJhbGciOiJIUzI1NiJ9.abc?size=1200',
    });
    const result = await resolveServerCoverForDiscord('al-lan', 'https://music.example.com');
    expect(result).toBe('https://music.example.com/share/img/eyJhbGciOiJIUzI1NiJ9.abc?size=1200');
  });

  it('never returns a URL carrying credentials, even if the server response had one', async () => {
    mockedGetAlbumInfo2.mockResolvedValueOnce({
      largeImageUrl: 'https://music.example.com/rest/getCoverArt.view?id=al-1&u=alice&t=deadbeef&s=abc123',
    });
    expect(await resolveServerCoverForDiscord('al-credentialed', null)).toBeNull();
  });

  it('returns null without calling the API when there is no shareBase and the response is empty', async () => {
    mockedGetAlbumInfo2.mockResolvedValueOnce({});
    expect(await resolveServerCoverForDiscord('al-empty', null)).toBeNull();
  });

  it('preserves a reverse-proxy path prefix from shareBase when rewriting origin', async () => {
    mockedGetAlbumInfo2.mockResolvedValueOnce({
      largeImageUrl: 'https://192.168.1.5:4533/share/img/eyJhbGciOiJIUzI1NiJ9.abc?size=1200',
    });
    const result = await resolveServerCoverForDiscord('al-proxy', 'https://music.example.com/nav');
    expect(result).toBe('https://music.example.com/nav/share/img/eyJhbGciOiJIUzI1NiJ9.abc?size=1200');
  });

  it('re-fetches after the cache TTL expires, including for a cached negative result', async () => {
    vi.useFakeTimers();
    try {
      mockedGetAlbumInfo2.mockResolvedValueOnce(null);
      expect(await resolveServerCoverForDiscord('al-ttl', null)).toBeNull();
      expect(mockedGetAlbumInfo2).toHaveBeenCalledTimes(1);

      // Still within the TTL window — cache hit, no second call.
      await vi.advanceTimersByTimeAsync(59 * 60 * 1000);
      expect(await resolveServerCoverForDiscord('al-ttl', null)).toBeNull();
      expect(mockedGetAlbumInfo2).toHaveBeenCalledTimes(1);

      // Past the TTL — must re-fetch instead of trusting the stale negative result.
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      mockedGetAlbumInfo2.mockResolvedValueOnce({ largeImageUrl: 'https://music.example.com/img/fresh.jpg' });
      expect(await resolveServerCoverForDiscord('al-ttl', null)).toBe('https://music.example.com/img/fresh.jpg');
      expect(mockedGetAlbumInfo2).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
