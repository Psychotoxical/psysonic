import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveCoverForDiscord } from './discord';
import { commands } from '@/generated/bindings';
import { getAlbumInfo2 } from '@/lib/api/subsonicAlbumInfo';

vi.mock('@/generated/bindings', () => ({
  commands: {
    resolveAppleCover: vi.fn(),
    resolveLastfmCover: vi.fn(),
  },
}));

vi.mock('@/lib/api/subsonicAlbumInfo', () => ({
  getAlbumInfo2: vi.fn(),
}));

const APPLE_OK = { status: 'ok' as const, data: 'https://apple.example/x.jpg' };
const APPLE_ERR = { status: 'error' as const, error: 'boom' };
const LASTFM_URL = 'https://lastfm.example/y.jpg';

describe('resolveCoverForDiscord', () => {
  beforeEach(() => {
    vi.mocked(getAlbumInfo2).mockReset();
    vi.mocked(commands.resolveAppleCover).mockReset();
    vi.mocked(commands.resolveLastfmCover).mockReset();
  });

  it('server miss → apple hit wins (order respected)', async () => {
    vi.mocked(getAlbumInfo2).mockResolvedValue(null as never); // no image → server miss
    vi.mocked(commands.resolveAppleCover).mockResolvedValue(APPLE_OK as never);
    const url = await resolveCoverForDiscord(
      [
        { source: 'server', enabled: true },
        { source: 'apple', enabled: true },
        { source: 'lastfm', enabled: true },
      ],
      { albumId: 'a1', artist: 'X', album: 'Y', title: 'Z', shareBase: null },
    );
    expect(url).toBe('https://apple.example/x.jpg');
    expect(getAlbumInfo2).toHaveBeenCalledWith('a1');
    expect(commands.resolveAppleCover).toHaveBeenCalledWith('X', 'Y', 'Z');
    expect(commands.resolveLastfmCover).not.toHaveBeenCalled();
  });

  it('skips a disabled source and still resolves the enabled one', async () => {
    vi.mocked(commands.resolveLastfmCover).mockResolvedValue(LASTFM_URL);
    const url = await resolveCoverForDiscord(
      [
        { source: 'server', enabled: false },
        { source: 'apple', enabled: false },
        { source: 'lastfm', enabled: true },
      ],
      { artist: 'A', album: 'B', shareBase: null },
    );
    expect(url).toBe(LASTFM_URL);
    expect(getAlbumInfo2).not.toHaveBeenCalled();
    expect(commands.resolveAppleCover).not.toHaveBeenCalled();
  });

  it('no enabled source → null', async () => {
    const url = await resolveCoverForDiscord(
      [
        { source: 'server', enabled: false },
        { source: 'apple', enabled: false },
        { source: 'lastfm', enabled: false },
      ],
      { artist: 'A', album: 'B', shareBase: null },
    );
    expect(url).toBeNull();
  });

  it('rejects a Last.fm placeholder URL and returns null when nothing else resolves', async () => {
    vi.mocked(getAlbumInfo2).mockResolvedValue(null as never);
    vi.mocked(commands.resolveLastfmCover).mockResolvedValue(
      'https://lastfm.example/2a96cbd8b46e442fc41c2b86b821562f.png',
    );
    const url = await resolveCoverForDiscord(
      [
        { source: 'server', enabled: true },
        { source: 'lastfm', enabled: true },
      ],
      { albumId: 'a1', artist: 'A', album: 'B', shareBase: null },
    );
    expect(url).toBeNull();
  });

  it('an apple error result is treated as a miss and walks on', async () => {
    vi.mocked(getAlbumInfo2).mockResolvedValue(null as never);
    vi.mocked(commands.resolveAppleCover).mockResolvedValue(APPLE_ERR as never);
    vi.mocked(commands.resolveLastfmCover).mockResolvedValue(LASTFM_URL);
    const url = await resolveCoverForDiscord(
      [
        { source: 'server', enabled: true },
        { source: 'apple', enabled: true },
        { source: 'lastfm', enabled: true },
      ],
      { albumId: 'a1', artist: 'A', album: 'B', title: 'C', shareBase: null },
    );
    expect(url).toBe(LASTFM_URL);
  });

  it('sanitizes a non-https URL to null (never returns it)', async () => {
    vi.mocked(getAlbumInfo2).mockResolvedValue(null as never);
    vi.mocked(commands.resolveLastfmCover).mockResolvedValue('http://lastfm.example/y.jpg');
    const url = await resolveCoverForDiscord(
      [
        { source: 'server', enabled: false },
        { source: 'apple', enabled: false },
        { source: 'lastfm', enabled: true },
      ],
      { artist: 'A', album: 'B', shareBase: null },
    );
    expect(url).toBeNull();
  });
});
