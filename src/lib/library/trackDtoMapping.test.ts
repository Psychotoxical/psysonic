import { describe, expect, it } from 'vitest';
import type { LibraryTrackDto } from '@/lib/api/library';
import { trackToSong } from './trackDtoMapping';

/**
 * What a library row turns into for the surfaces that render songs.
 *
 * The interesting part is the tug of war between the hot columns and the
 * `rawJson` snapshot: the snapshot is the original server answer and wins
 * almost everywhere, because it carries fields the columns do not. Play
 * statistics are the exception — they change without the row being synced.
 */

const dto = (overrides: Partial<LibraryTrackDto> = {}): LibraryTrackDto => ({
  serverId: 's1',
  id: 't1',
  title: 'Into the Everblack',
  album: 'Everblack',
  durationSec: 274,
  syncedAt: 1_000,
  rawJson: undefined,
  ...overrides,
});

describe('trackToSong play statistics', () => {
  it('shows when the track was last played', () => {
    const song = trackToSong(dto({ playedAt: Date.UTC(2026, 7, 25, 20, 55, 58) }));

    expect(song.played).toBe('2026-08-25T20:55:58.000Z');
  });

  it('has no last-played when the track has never been played', () => {
    expect(trackToSong(dto()).played).toBeUndefined();
  });

  it('shows the play count', () => {
    expect(trackToSong(dto({ playCount: 4 })).playCount).toBe(4);
  });

  it('prefers the columns over the snapshot they outlive', () => {
    // The snapshot is whatever the server said when the row was last synced.
    // Every play since then only moves the columns, so taking the snapshot
    // would report a count and a date that are both known to be stale.
    const song = trackToSong(dto({
      playCount: 4,
      playedAt: Date.UTC(2026, 7, 25, 20, 55, 58),
      rawJson: { playCount: 3, played: '2026-08-25T14:06:45.987Z' },
    }));

    expect(song.playCount).toBe(4);
    expect(song.played).toBe('2026-08-25T20:55:58.000Z');
  });

  it('falls back to the snapshot when the columns hold nothing', () => {
    // A row synced before this app ever wrote a column still has the server's
    // own numbers in the snapshot; dropping them would lose real history.
    const song = trackToSong(dto({
      rawJson: { playCount: 3, played: '2026-08-25T14:06:45.987Z' },
    }));

    expect(song.playCount).toBe(3);
    expect(song.played).toBe('2026-08-25T14:06:45.987Z');
  });

  it('leaves the rest of the snapshot in charge', () => {
    // The exception is meant to be narrow: everything else the snapshot says
    // still wins, including fields the columns have no room for.
    const song = trackToSong(dto({
      title: 'Column title',
      playCount: 4,
      rawJson: { title: 'Snapshot title', bitRate: 320 },
    }));

    expect(song.title).toBe('Snapshot title');
    expect(song.bitRate).toBe(320);
    expect(song.playCount).toBe(4);
  });
});

describe('trackToSong play count against a stale snapshot', () => {
  it('prefers the column over the frozen snapshot', () => {
    const song = trackToSong(dto({ playCount: 6, rawJson: { playCount: 5 } }));

    expect(song.playCount).toBe(6);
  });

  it('takes a column that is lower than the snapshot', () => {
    // Both numbers are the server's own tally at different moments, and the
    // column is the more recent one — a play refreshes it from the server. A
    // count that only ever moved upwards could never follow a correction or a
    // reset on the server side.
    const song = trackToSong(dto({ playCount: 1, rawJson: { playCount: 5 } }));

    expect(song.playCount).toBe(1);
  });
});

describe('trackToSong last played from a native payload', () => {
  it("reads Navidrome's playDate when the column was never filled", () => {
    // Rows ingested before the mapper knew the field name kept the date only in
    // the snapshot. Nothing revisits them: a play does not move `updatedAt`, so
    // the delta sync never offers the row again.
    const song = trackToSong(dto({ rawJson: { playDate: '2026-08-25T14:06:45.987Z' } }));

    expect(song.played).toBe('2026-08-25T14:06:45.987Z');
  });

  it('lets the column win over playDate', () => {
    const song = trackToSong(
      dto({
        playedAt: Date.UTC(2026, 7, 25, 20, 55, 58),
        rawJson: { playDate: '2026-08-25T14:06:45.987Z' },
      }),
    );

    expect(song.played).toBe('2026-08-25T20:55:58.000Z');
  });

  it('ignores an empty playDate, which Navidrome sends for never-played rows', () => {
    const song = trackToSong(dto({ rawJson: { playDate: '' } }));

    expect(song.played).toBeUndefined();
  });
});
