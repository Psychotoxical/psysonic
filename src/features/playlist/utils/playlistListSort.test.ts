import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLAYLIST_LIST_SORT,
  isPlaylistListSortKey,
  sortPlaylistList,
} from '@/features/playlist/utils/playlistListSort';

const pl = (name: string, created: string, songCount: number) => ({ name, created, songCount });

const names = (list: readonly { name: string }[]) => list.map(p => p.name);

describe('sortPlaylistList', () => {
  const sample = [
    pl('Beta', '2026-01-02T00:00:00Z', 10),
    pl('alpha', '2026-03-01T00:00:00Z', 3),
    pl('Gamma', '2026-02-01T00:00:00Z', 42),
  ];

  it('orders by name case-insensitively, the way a reader scans the list', () => {
    expect(names(sortPlaylistList(sample, 'name'))).toEqual(['alpha', 'Beta', 'Gamma']);
  });

  it('puts the newest first for created', () => {
    expect(names(sortPlaylistList(sample, 'created'))).toEqual(['alpha', 'Gamma', 'Beta']);
  });

  it('puts the largest first for songCount', () => {
    expect(names(sortPlaylistList(sample, 'songCount'))).toEqual(['Gamma', 'Beta', 'alpha']);
  });

  it('sorts a smart playlist by the name that is actually shown', () => {
    // Stored as `psy-smart-…`, rendered without the prefix. Sorting the raw
    // value would file this one under P, between Beta and Gamma.
    const withSmart = [...sample, pl('psy-smart-90s Rock', '2026-01-01T00:00:00Z', 1)];
    expect(names(sortPlaylistList(withSmart, 'name'))).toEqual([
      'psy-smart-90s Rock',
      'alpha',
      'Beta',
      'Gamma',
    ]);
  });

  it('never mutates the input', () => {
    const input = [...sample];
    sortPlaylistList(input, 'songCount');
    expect(names(input)).toEqual(['Beta', 'alpha', 'Gamma']);
  });

  it('breaks a created tie by name so the order cannot wobble between renders', () => {
    const sameDay = [
      pl('Zulu', '2026-05-05T00:00:00Z', 1),
      pl('Alfa', '2026-05-05T00:00:00Z', 9),
    ];
    expect(names(sortPlaylistList(sameDay, 'created'))).toEqual(['Alfa', 'Zulu']);
  });

  it('breaks a songCount tie by name', () => {
    const sameCount = [
      pl('Zulu', '2026-01-01T00:00:00Z', 7),
      pl('Alfa', '2026-02-02T00:00:00Z', 7),
    ];
    expect(names(sortPlaylistList(sameCount, 'songCount'))).toEqual(['Alfa', 'Zulu']);
  });

  it('sorts an unparsable or missing created date oldest instead of throwing', () => {
    const messy = [
      { name: 'Broken', created: 'not-a-date', songCount: 1 },
      { name: 'Missing', created: undefined as unknown as string, songCount: 1 },
      pl('Real', '2026-01-01T00:00:00Z', 1),
    ];
    expect(names(sortPlaylistList(messy, 'created'))).toEqual(['Real', 'Broken', 'Missing']);
  });

  it('treats a missing song count as zero', () => {
    const messy = [
      { name: 'Unknown', created: '2026-01-01T00:00:00Z', songCount: undefined as unknown as number },
      pl('Counted', '2026-01-01T00:00:00Z', 5),
    ];
    expect(names(sortPlaylistList(messy, 'songCount'))).toEqual(['Counted', 'Unknown']);
  });

  it('falls back to name ordering for the default key', () => {
    expect(DEFAULT_PLAYLIST_LIST_SORT).toBe('name');
    expect(names(sortPlaylistList(sample, DEFAULT_PLAYLIST_LIST_SORT))).toEqual(['alpha', 'Beta', 'Gamma']);
  });
});

describe('isPlaylistListSortKey', () => {
  it('accepts the three known keys and rejects anything else', () => {
    for (const value of ['name', 'created', 'songCount']) {
      expect(isPlaylistListSortKey(value)).toBe(true);
    }
    // 'lastPlayed' is the one the reporter asked for and the one the data cannot
    // answer — pinned here so a future addition is a deliberate act.
    for (const value of ['lastPlayed', 'duration', '', null, undefined, 5, {}]) {
      expect(isPlaylistListSortKey(value)).toBe(false);
    }
  });
});
