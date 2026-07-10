import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicStructuredLyrics } from '@/lib/api/subsonicTypes';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock('@/lib/api/subsonicClient', () => ({ api: apiMock }));

import { getLyricsBySongId, isMainLyricsKind, pickMainStructuredLyrics } from '@/lib/api/subsonicLyrics';

function lyrics(overrides: Partial<SubsonicStructuredLyrics> = {}): SubsonicStructuredLyrics {
  return { line: [{ start: 0, value: 'la' }], ...overrides };
}

beforeEach(() => {
  apiMock.mockReset();
});

describe('isMainLyricsKind', () => {
  it('treats a missing kind as main (songLyrics v1 never sends one)', () => {
    expect(isMainLyricsKind(lyrics())).toBe(true);
  });

  it('rejects translation and pronunciation layers', () => {
    expect(isMainLyricsKind(lyrics({ kind: 'translation' }))).toBe(false);
    expect(isMainLyricsKind(lyrics({ kind: 'pronunciation' }))).toBe(false);
  });
});

describe('pickMainStructuredLyrics', () => {
  it('never returns a translation layer in place of the original text', () => {
    const translation = lyrics({ kind: 'translation', synced: true, line: [{ start: 0, value: 'übersetzt' }] });
    const main = lyrics({ kind: 'main', synced: false, line: [{ value: 'original' }] });
    // The synced translation comes first — a naive "first synced" pick would take it.
    expect(pickMainStructuredLyrics([translation, main])).toBe(main);
  });

  it('prefers a synced main layer over an unsynced one', () => {
    const unsynced = lyrics({ line: [{ value: 'plain' }] });
    const synced = lyrics({ synced: true });
    expect(pickMainStructuredLyrics([unsynced, synced])).toBe(synced);
  });

  it('accepts the legacy issynced casing', () => {
    const unsynced = lyrics({ line: [{ value: 'plain' }] });
    const synced = lyrics({ issynced: true });
    expect(pickMainStructuredLyrics([unsynced, synced])).toBe(synced);
  });

  it('falls back to the unfiltered list when no entry is main', () => {
    const translation = lyrics({ kind: 'translation' });
    expect(pickMainStructuredLyrics([translation])).toBe(translation);
  });

  it('returns null for an empty list', () => {
    expect(pickMainStructuredLyrics([])).toBeNull();
  });
});

describe('getLyricsBySongId', () => {
  it('omits the enhanced parameter by default', async () => {
    apiMock.mockResolvedValue({ lyricsList: { structuredLyrics: [lyrics()] } });
    await getLyricsBySongId('song-1');
    expect(apiMock).toHaveBeenCalledWith('getLyricsBySongId.view', { id: 'song-1' });
  });

  it('requests enhanced data when asked', async () => {
    apiMock.mockResolvedValue({ lyricsList: { structuredLyrics: [lyrics()] } });
    await getLyricsBySongId('song-1', { enhanced: true });
    expect(apiMock).toHaveBeenCalledWith('getLyricsBySongId.view', { id: 'song-1', enhanced: true });
  });

  it('returns null when the track has no lyrics', async () => {
    apiMock.mockResolvedValue({ lyricsList: {} });
    await expect(getLyricsBySongId('song-1')).resolves.toBeNull();
  });

  it('returns null when the server does not support the endpoint', async () => {
    apiMock.mockRejectedValue(new Error('not supported'));
    await expect(getLyricsBySongId('song-1')).resolves.toBeNull();
  });
});
