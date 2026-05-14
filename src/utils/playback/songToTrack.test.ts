/**
 * Pure-helper characterization for `songToTrack`.
 *
 * Maps a Subsonic song record into the internal `Track` shape used by the
 * playback queue. Originally lived in `playerStore.ts`; extracted in M0 of
 * the frontend refactor (2026-05-12).
 */
import type { Track } from '../../store/playerStoreTypes';
import { describe, expect, it } from 'vitest';
import { songToTrack } from './songToTrack';
import { makeSubsonicSong } from '@/test/helpers/factories';

describe('songToTrack', () => {
  it('maps required Subsonic fields verbatim', () => {
    const song = makeSubsonicSong({
      id: 's1',
      title: 'Hello',
      artist: 'World',
      album: 'Sample',
      albumId: 'a1',
      duration: 240,
    });
    const t = songToTrack(song);
    expect(t.id).toBe('s1');
    expect(t.title).toBe('Hello');
    expect(t.artist).toBe('World');
    expect(t.album).toBe('Sample');
    expect(t.albumId).toBe('a1');
    expect(t.duration).toBe(240);
  });

  it('copies optional fields when present', () => {
    const song = makeSubsonicSong({
      id: 's2',
      artistId: 'ar-1',
      track: 5,
      year: 2024,
      bitRate: 320,
      suffix: 'flac',
      userRating: 4,
      starred: '2026-05-01T00:00:00Z',
      genre: 'Rock',
      samplingRate: 48000,
      bitDepth: 24,
      size: 9_000_000,
      coverArt: 's2',
    });
    const t = songToTrack(song);
    expect(t.artistId).toBe('ar-1');
    expect(t.track).toBe(5);
    expect(t.year).toBe(2024);
    expect(t.bitRate).toBe(320);
    expect(t.suffix).toBe('flac');
    expect(t.userRating).toBe(4);
    expect(t.starred).toBe('2026-05-01T00:00:00Z');
    expect(t.genre).toBe('Rock');
    expect(t.samplingRate).toBe(48000);
    expect(t.bitDepth).toBe(24);
    expect(t.size).toBe(9_000_000);
    expect(t.coverArt).toBe('s2');
  });

  it('flattens replayGain into replayGainTrackDb / AlbumDb / Peak', () => {
    const song = makeSubsonicSong({
      replayGain: {
        trackGain: -6.5,
        albumGain: -7.1,
        trackPeak: 0.98,
        albumPeak: 0.99,
      },
    });
    const t = songToTrack(song);
    expect(t.replayGainTrackDb).toBe(-6.5);
    expect(t.replayGainAlbumDb).toBe(-7.1);
    expect(t.replayGainPeak).toBe(0.98);
    // albumPeak is intentionally not surfaced — only trackPeak.
    expect((t as Track & { replayGainAlbumPeak?: number }).replayGainAlbumPeak).toBeUndefined();
  });

  it('leaves replayGain fields undefined when the song has no replayGain block', () => {
    const song = makeSubsonicSong({ replayGain: undefined });
    const t = songToTrack(song);
    expect(t.replayGainTrackDb).toBeUndefined();
    expect(t.replayGainAlbumDb).toBeUndefined();
    expect(t.replayGainPeak).toBeUndefined();
  });

  it('does not invent fields that the Subsonic song lacks', () => {
    const song = makeSubsonicSong({});
    const t = songToTrack(song);
    // Internal queue-routing flags are added by enqueue paths, not by mapping.
    expect(t.autoAdded).toBeUndefined();
    expect(t.radioAdded).toBeUndefined();
    expect(t.playNextAdded).toBeUndefined();
  });
});
