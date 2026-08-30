import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicStructuredLyrics } from '@/lib/api/subsonicTypes';

const { apiMock, apiForServerMock } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  apiForServerMock: vi.fn(),
}));

vi.mock('@/lib/api/subsonicClient', () => ({ api: apiMock, apiForServer: apiForServerMock }));

import { getLyricsBySongId, isMainLyricsKind, pickMainStructuredLyrics } from '@/lib/api/subsonicLyrics';

function lyrics(overrides: Partial<SubsonicStructuredLyrics> = {}): SubsonicStructuredLyrics {
  return { line: [{ start: 0, value: 'la' }], ...overrides };
}

beforeEach(() => {
  apiMock.mockReset();
  apiForServerMock.mockReset();
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

// A FLAC whose LYRICS vorbis comment is repeated once per line: the server maps
// each tag value to its own entry, so one layer arrives as N single-line entries
// with the same lang and sync state. Shape taken from a Navidrome 0.63.2
// response. Picking only the first entry showed one line (issue #1472).
describe('pickMainStructuredLyrics with a layer split across entries', () => {
  const split = [
    lyrics({ lang: 'xxx', synced: true, line: [{ start: 1000, value: 'line one' }] }),
    lyrics({ lang: 'xxx', synced: true, line: [{ start: 5000, value: 'line two' }] }),
    lyrics({ lang: 'xxx', synced: true, line: [{ start: 9000, value: 'line three' }] }),
  ];

  it('concatenates the entries into one layer', () => {
    expect(pickMainStructuredLyrics(split)?.line).toEqual([
      { start: 1000, value: 'line one' },
      { start: 5000, value: 'line two' },
      { start: 9000, value: 'line three' },
    ]);
  });

  it('leaves a single multi-line entry untouched', () => {
    // The same tag written as one multi-line value — the shape that already worked.
    const whole = lyrics({
      lang: 'xxx',
      synced: true,
      line: [
        { start: 1000, value: 'line one' },
        { start: 5000, value: 'line two' },
      ],
    });
    expect(pickMainStructuredLyrics([whole])).toBe(whole);
  });

  it('does not absorb a translation sharing the language', () => {
    const translation = lyrics({
      kind: 'translation',
      lang: 'xxx',
      synced: true,
      line: [{ start: 1000, value: 'translated' }],
    });
    expect(pickMainStructuredLyrics([...split, translation])?.line).toHaveLength(3);
  });

  it('keeps kinds apart when no entry is main', () => {
    // The only path where `kind` decides the grouping: with no main layer the
    // pool is unfiltered, so translation and pronunciation reach it together
    // and must not be concatenated into one.
    const translation = lyrics({ kind: 'translation', lang: 'xxx', synced: true, line: [{ start: 1000, value: 'translated' }] });
    const pronunciation = lyrics({ kind: 'pronunciation', lang: 'xxx', synced: true, line: [{ start: 1000, value: 'spoken' }] });
    const picked = pickMainStructuredLyrics([translation, pronunciation]);
    expect(picked?.line).toEqual([{ start: 1000, value: 'translated' }]);
  });

  it('does not absorb an unsynced entry of the same language', () => {
    const unsynced = lyrics({ lang: 'xxx', line: [{ value: 'plain' }] });
    expect(pickMainStructuredLyrics([...split, unsynced])?.line).toHaveLength(3);
  });

  it('keeps a different language as its own layer', () => {
    const other = lyrics({ lang: 'eng', synced: true, line: [{ start: 1000, value: 'english' }] });
    expect(pickMainStructuredLyrics([...split, other])?.line).toHaveLength(3);
  });

  it('shifts cue line indexes onto the concatenated line positions', () => {
    // Without the shift every appended cue line would point at line 0 and
    // highlight the wrong words.
    const withCues = split.map((entry, i) =>
      lyrics({ ...entry, cueLine: [{ index: 0, value: entry.line[0].value, cue: [
        { start: (i + 1) * 1000, value: entry.line[0].value, byteStart: 0, byteEnd: 7 },
      ] }] }),
    );
    expect(pickMainStructuredLyrics(withCues)?.cueLine?.map(c => c.index)).toEqual([0, 1, 2]);
  });

  it('reassembles fields of uneven length', () => {
    // A tag field can hold a whole verse, so the pieces are not one line each.
    // Shape measured on Navidrome 0.63.2 for three fields, the middle one
    // holding two lines.
    const uneven = [
      lyrics({ lang: 'xxx', synced: true, line: [{ start: 1000, value: 'line one' }] }),
      lyrics({ lang: 'xxx', synced: true, line: [
        { start: 5000, value: 'line two' }, { start: 7000, value: 'line two b' },
      ] }),
      lyrics({ lang: 'xxx', synced: true, line: [{ start: 9000, value: 'line three' }] }),
    ];
    expect(pickMainStructuredLyrics(uneven)?.line).toHaveLength(4);
  });

  it('ignores entries whose line array is missing', () => {
    // Raw server JSON: `line` is required by the type but can be absent in
    // practice. Reaching `parseStructuredLyrics` with one throws out of the
    // fetch pipeline uncaught, which would hang the pane on "loading".
    const malformed = { lang: 'xxx', synced: true } as unknown as SubsonicStructuredLyrics;
    expect(() => pickMainStructuredLyrics([malformed, ...split])).not.toThrow();
    expect(pickMainStructuredLyrics([malformed, ...split])?.line).toHaveLength(3);
  });

  it('returns null when no entry has a usable line array', () => {
    const malformed = { lang: 'xxx', synced: true } as unknown as SubsonicStructuredLyrics;
    expect(pickMainStructuredLyrics([malformed])).toBeNull();
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

  it('uses the explicit owning server without consulting the active client', async () => {
    apiForServerMock.mockResolvedValue({ lyricsList: { structuredLyrics: [lyrics()] } });
    await getLyricsBySongId('song-1', { serverId: 'srv-owner' });
    expect(apiForServerMock).toHaveBeenCalledWith(
      'srv-owner',
      'getLyricsBySongId.view',
      { id: 'song-1' },
    );
    expect(apiMock).not.toHaveBeenCalled();
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
